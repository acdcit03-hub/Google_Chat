import cron from 'node-cron';
import QtyReservationModel from '../../models/r2r/qtyReservation.model.js';
import SettingModel from '../../models/settings/setting.model.js';
import { broadcastQtyReservationUpdate } from '../../config/socket.js';

const EXPIRE_HOURS_KEY = 'expire_hours';

function storeApiBase() {
  return String(
   
      process.env.NEXT_PUBLIC_STORE_API ||
      
      '',
  )
    .trim()
    .replace(/\/+$/, '');
}

function str(value) {
  if (value == null) return '';
  return String(value).trim();
}

/**
 * GET /store/history?id={removeQtyId}
 * Filter out ADD, then use username / assigned_user.
 */
async function fetchRemoveHistoryUsername(base, removeQtyId) {
  const id = str(removeQtyId);
  if (!base || !id) return '';

  try {
    const url = `${base}/store/history?id=${encodeURIComponent(id)}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });
    if (!res.ok) return '';
    const body = await res.json().catch(() => null);
    const history = Array.isArray(body?.data)
      ? body.data
      : body?.data && typeof body.data === 'object'
        ? [body.data]
        : [];

    const filteredHistory = history.filter(
      (item) => String(item?.type ?? '').toUpperCase() !== 'ADD',
    );
    if (!filteredHistory.length) return '';

    const row =
      filteredHistory.find((r) => str(r?.id) === id) || filteredHistory[0];
    return str(row?.username) || str(row?.assigned_user);
  } catch (err) {
    console.error(
      `Qty reservation expire: history username fetch failed for id=${id}:`,
      err?.message || err,
    );
    return '';
  }
}

/**
 * After auto-expire, update store remove-quantity rows (same shape as cancel).
 * PUT /store/edit-remove-quantity/{firstId}
 * body: [{ id, quantity: 0, type: 'REMOVE', transaction_type: 'Expired', username, ... }]
 */
async function syncExpiredRemoveQuantity(expiredRows) {
  const base = storeApiBase();
  if (!base) {
    console.error(
      'Qty reservation expire: STORE API base URL not configured — skip edit-remove-quantity',
    );
    return { attempted: 0, ok: false };
  }

  const removeIds = [];
  for (const row of expiredRows) {
    const removeQtyID = str(
      row?.remove_qtyID ?? row?.remove_qtyid ?? row?.remove_qty_id,
    );
    if (!removeQtyID) continue;
    removeIds.push(removeQtyID);
  }

  if (removeIds.length === 0) return { attempted: 0, ok: false };

  const items = await Promise.all(
    removeIds.map(async (removeQtyID) => {
      const username = await fetchRemoveHistoryUsername(base, removeQtyID);
      const item = {
        id: removeQtyID,
        quantity: 0,
        type: 'REMOVE',
        transaction_type: 'Expired',
        project_code: '',
        lot_no: '',
        pcb_code: '',
        edited_type: 'System',
      };
      if (username) item.username = username;
      return item;
    }),
  );

  const urlId = encodeURIComponent(String(items[0].id));
  const url = `${base}/store/edit-remove-quantity/${urlId}`;
  const headerUsername = str(items.find((i) => i.username)?.username);

  try {
    const res = await fetch(url, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        ...(headerUsername ? { 'x-store-username': headerUsername } : {}),
      },
      body: JSON.stringify(items),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error(
        `Qty reservation expire edit-remove-quantity failed (${res.status}):`,
        text || res.statusText,
      );
      return { attempted: items.length, ok: false };
    }
    return { attempted: items.length, ok: true };
  } catch (err) {
    console.error(
      'Qty reservation expire edit-remove-quantity error:',
      err?.message || err,
    );
    return { attempted: items.length, ok: false };
  }
}

async function resolveExpireDuration() {
  try {
    const row = await SettingModel.findByKey(EXPIRE_HOURS_KEY);
    return QtyReservationModel.parseExpireDuration(row?.value);
  } catch (err) {
    console.error(
      'Qty reservation expire: failed reading expire_hours setting:',
      err?.message || err,
    );
    return { hours: 24, minutes: 0, seconds: 0 };
  }
}

/**
 * Move Pending Reserve → Reserve Expired after settings.expire_hours
 * (`24h,0m,0s`) from created_at.
 * Then call store edit-remove-quantity for each remove_qtyID.
 */
export async function runQtyReservationExpireCheck() {
  const duration = await resolveExpireDuration();
  const expired = await QtyReservationModel.expirePendingPastDuration(duration);
  if (!expired.length) return { duration, count: 0 };

  for (const row of expired) {
    try {
      broadcastQtyReservationUpdate('updated', row);
    } catch (err) {
      console.error(
        'Qty reservation expire broadcast failed:',
        err?.message || err,
      );
    }
  }

  const storeSync = await syncExpiredRemoveQuantity(expired);

  const label = `${duration.hours}h,${duration.minutes}m,${duration.seconds}s`;
  console.log(
    `✅ Qty reservation expired: ${expired.length} row(s) (after ${label})` +
      (storeSync.attempted
        ? `; store edit-remove-quantity ${storeSync.ok ? 'ok' : 'failed'} (${storeSync.attempted})`
        : '; no remove_qtyID to sync'),
  );
  return { duration, count: expired.length, storeSync };
}

console.log('✅ Qty Reservation Expire Cron Started');

// Every 10s so hh/mm/ss expiry (e.g. 0h,1m,0s) is checked promptly
cron.schedule('*/10 * * * * *', async () => {
  try {
    await runQtyReservationExpireCheck();
  } catch (err) {
    console.error('Qty Reservation Expire Error:', err);
  }
});
