import { timeToSeconds } from './time.utils.js';

/** Normalize HH:MM or HH:MM:SS to seconds; null for invalid / ongoing stop. */
export function normalizeTimeToSeconds(value) {
    const raw = String(value ?? '').trim();
    if (!raw || raw.toLowerCase() === 'ongoing') return null;
    const withSeconds = /^\d{1,2}:\d{2}$/.test(raw) ? `${raw}:00` : raw;
    return timeToSeconds(withSeconds);
}

export function isOngoingStopTime(value) {
    const s = String(value ?? '').trim();
    return !s || s.toLowerCase() === 'ongoing';
}

/**
 * Resolve interval end in seconds for overlap checks.
 * Ongoing entries extend to `maxEndSeconds` (usually now or end of day).
 */
export function resolveIntervalEnd(stopTime, maxEndSeconds) {
    if (isOngoingStopTime(stopTime)) {
        return maxEndSeconds;
    }
    const stop = normalizeTimeToSeconds(stopTime);
    if (stop == null) return null;
    return stop;
}

/** True when [startA, endA) overlaps [startB, endB) — touching edges allowed. */
export function intervalsOverlap(startA, endA, startB, endB) {
    if (
        startA == null ||
        endA == null ||
        startB == null ||
        endB == null ||
        endA <= startA ||
        endB <= startB
    ) {
        return false;
    }
    return startA < endB && startB < endA;
}

export function formatOverlapTimeLabel(value) {
    const secs = normalizeTimeToSeconds(value);
    if (secs == null) return 'Ongoing';
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    return [h, m, s].map((v) => String(v).padStart(2, '0')).join(':');
}

/**
 * Find first existing entry that overlaps the candidate interval on the same day.
 */
export function findOverlappingEntry(
    entries,
    candidate,
    { excludeId, maxEndSeconds = 86399 } = {},
) {
    const start = normalizeTimeToSeconds(candidate.start_time);
    if (start == null) return null;

    const end = resolveIntervalEnd(candidate.stop_time, maxEndSeconds);
    if (end == null || end <= start) return null;

    for (const row of entries || []) {
        const rowId = row?.id != null ? Number(row.id) : null;
        if (excludeId != null && rowId === Number(excludeId)) continue;

        const otherStart = normalizeTimeToSeconds(row.start_time);
        if (otherStart == null) continue;

        const otherEnd = resolveIntervalEnd(row.stop_time, maxEndSeconds);
        if (otherEnd == null || otherEnd <= otherStart) continue;

        if (intervalsOverlap(start, end, otherStart, otherEnd)) {
            return row;
        }
    }

    return null;
}

export function buildOverlapErrorMessage(row, candidateStartTime) {
    const project = String(row?.project_code ?? '').trim() || 'Entry';
    const process = String(row?.process_name ?? '').trim();
    const label = process ? `${project} / ${process}` : project;
    const start = formatOverlapTimeLabel(row?.start_time);
    const stop = isOngoingStopTime(row?.stop_time)
        ? 'Ongoing'
        : formatOverlapTimeLabel(row?.stop_time);

    const otherStart = normalizeTimeToSeconds(row?.start_time);
    const candidateStart = normalizeTimeToSeconds(candidateStartTime);
    const prefix =
        otherStart != null &&
        candidateStart != null &&
        otherStart < candidateStart
            ? 'Previous entry'
            : 'Next entry';

    return `Not allowed — ${prefix} is ${start} – ${stop} (${label})`;
}

export function assertStopAfterStart(startTime, stopTime) {
    const start = String(startTime ?? '').trim();
    const stop = String(stopTime ?? '').trim();
    if (!start || !stop || isOngoingStopTime(stop)) return;

    const startSecs = normalizeTimeToSeconds(start);
    const stopSecs = normalizeTimeToSeconds(stop);
    if (startSecs == null || stopSecs == null) return;

    if (stopSecs <= startSecs) {
        throw new Error('Not allowed — stop time must be after start time');
    }
}
