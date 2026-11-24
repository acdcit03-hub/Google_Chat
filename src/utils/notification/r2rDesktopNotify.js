import { getIO } from '../../config/socket.js';

/** Map ISSUE page_name / workflow to R2R route for notification click-through. */
function pageNameToHref(pageName, fallback = '/r2r/purchase-request') {
    const p = String(pageName ?? '')
        .trim()
        .toLowerCase();
    if (p.includes('collection')) return '/r2r/collection-desk';
    if (p.includes('in store')) return '/r2r/instore-check';
    if (p === 'purchase') return '/r2r/purchases';
    if (p.includes('order placed') || p.includes('order')) return '/r2r/order-placed';
    if (p.includes('receive issue')) {
        return '/r2r/purchase-request?filter=receiveIssue';
    }
    if (p.includes('receive')) return '/r2r/receive-items';
    if (p.includes('request review')) return '/r2r/request-review';
    return fallback;
}

function serialLabel(serial, srNo) {
    if (serial) return String(serial).trim();
    if (srNo != null && String(srNo).trim() !== '') return `SR-${srNo}`;
    return 'Requirement';
}

function buildEventId(prefix, parts) {
    return `${prefix}-${parts.filter(Boolean).join('-')}-${Date.now()}`;
}

/**
 * Emit desktop-friendly notification-update (client shows OS popup).
 */
function emitDesktopNotification(payload) {
    const io = getIO();
    if (!io || !payload?.username) return;
    io.emit('notification-update', {
        type: 'popup-only',
        ...payload,
    });
}

/**
 * Issue / terminate socket payload with title, message, href for desktop + sidebar.
 */
function buildIssueSocketPayload({
    username,
    socketType,
    title,
    message,
    serial_number,
    sr_no,
    requirement_id,
    issue,
    page_name,
}) {
    const issueObj = issue && typeof issue === 'object' ? issue : {};
    const page = page_name || issueObj.page_name || '';
    const serial = serialLabel(
        serial_number || issueObj.serial_number,
        sr_no ?? requirement_id ?? issueObj.requirement_id,
    );

    return {
        username: String(username || '').trim(),
        type: socketType,
        title: title || 'Issue',
        message:
            message ||
            (page
                ? `${serial}: issue from ${page}`
                : `${serial}: new issue reported`),
        serial_number: serial_number || issueObj.serial_number || undefined,
        sr_no: sr_no ?? requirement_id ?? issueObj.requirement_id,
        requirement_id: requirement_id ?? issueObj.requirement_id,
        href: pageNameToHref(page),
        event_id: buildEventId(socketType, [requirement_id ?? serial]),
        issue: issueObj,
    };
}

function emitIssueSocket(payload) {
    const io = getIO();
    if (!io || !payload?.username) return;
    io.emit('notification-update', payload);
}

export {
    pageNameToHref,
    emitDesktopNotification,
    buildIssueSocketPayload,
    emitIssueSocket,
    serialLabel,
};
