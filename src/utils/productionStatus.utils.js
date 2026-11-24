export const PRODUCTION_STATUSES = [
    { label: 'In-Planning', key: 'inPlanning' },
    { label: 'Pre Production', key: 'preProduction' },
    { label: 'In Production', key: 'inProduction' },
    { label: 'Received', key: 'received' },
    { label: 'On Hold', key: 'onHold' },
    { label: 'Stopped', key: 'stopped' },
    { label: 'Completed', key: 'completed' },
    { label: 'Ready for pick up', key: 'readyForPickup' },
];

const STATUS_KEY_BY_NORMALIZED = Object.fromEntries(
    PRODUCTION_STATUSES.map(({ label, key }) => [
        label.trim().toLowerCase().replace(/[-_]+/g, ' ').replace(/\s+/g, ' '),
        key,
    ]),
);

export const PRODUCTION_DEFAULT_STATUS = PRODUCTION_STATUSES[0].label;

export function emptyProductionStatusCounts() {
    return Object.fromEntries(
        PRODUCTION_STATUSES.map(({ key }) => [key, 0]),
    );
}

export function resolveProductionStatusKey(rawStatus) {
    const normalized = String(rawStatus ?? '')
        .trim()
        .toLowerCase()
        .replace(/[-_]+/g, ' ')
        .replace(/\s+/g, ' ');

    if (!normalized) return null;
    return STATUS_KEY_BY_NORMALIZED[normalized] ?? null;
}
