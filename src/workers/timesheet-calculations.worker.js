import { parentPort, workerData } from 'worker_threads';

/**
 * Timesheet Calculations Worker Thread
 * 
 * This worker performs CPU-intensive timesheet calculations in a separate thread,
 * preventing the main event loop from being blocked.
 * 
 * Thread Communication:
 * - Receives data via: workerData (passed during Worker initialization)
 * - Sends result back via: parentPort.postMessage({...})
 */

const { timesheets, operation } = workerData;

try {
    let result;

    switch (operation) {
        case 'calculateCommonTime':
            result = calculateCommonTime(timesheets);
            break;
        case 'calculateTotalDuration':
            result = calculateTotalDuration(timesheets);
            break;
        case 'calculateNetTime':
            result = calculateNetTime(timesheets);
            break;
        case 'calculateNetTimeByDate':
            result = calculateNetTimeByDate(timesheets);
            break;
        default:
            throw new Error(`Unknown operation: ${operation}`);
    }

    // Send result back to main thread
    // parentPort.postMessage() is the way to communicate with the main thread
    parentPort.postMessage({
        success: true,
        result: result,
        operation: operation
    });

} catch (error) {
    console.error(`[Worker Thread] Error during calculation:`, error);
    
    // Send error back to main thread
    parentPort.postMessage({
        success: false,
        error: error.message
    });
}

/**
 * Calculate common/overlapping time between all timesheet entries
 * This is CPU-intensive for large datasets
 */
function calculateCommonTime(timesheets) {
    if (!timesheets || timesheets.length === 0) {
        return { hours: 0, minutes: 0, seconds: 0 };
    }

    // Convert time strings to seconds
    const timeToSeconds = (timeStr) => {
        if (!timeStr || timeStr === '-' || timeStr === 'Ongoing') return null;
        const match = timeStr.match(/^(\d{1,2}):(\d{2}):(\d{2})$/);
        if (!match) return null;
        const hours = parseInt(match[1], 10);
        const minutes = parseInt(match[2], 10);
        const seconds = parseInt(match[3], 10);
        return hours * 3600 + minutes * 60 + seconds;
    };

    // Get all valid time intervals
    const intervals = timesheets
        .map((entry) => {
            const start = timeToSeconds(entry.start_time);
            const stop = timeToSeconds(entry.stop_time);
            if (start !== null && stop !== null && stop > start) {
                return [start, stop];
            }
            return null;
        })
        .filter(Boolean);

    if (intervals.length === 0) {
        return { hours: 0, minutes: 0, seconds: 0 };
    }

    // Calculate total seconds (sum of all intervals)
    const totalSeconds = intervals.reduce((sum, [start, stop]) => sum + (stop - start), 0);

    // Sort intervals by start time
    intervals.sort((a, b) => a[0] - b[0]);

    // Calculate union of intervals (non-overlapping total time)
    let unionSeconds = 0;
    let currentStart = intervals[0][0];
    let currentEnd = intervals[0][1];

    for (let i = 1; i < intervals.length; i++) {
        const [nextStart, nextEnd] = intervals[i];
        if (nextStart < currentEnd) {
            // Overlapping intervals - merge them
            currentEnd = Math.max(currentEnd, nextEnd);
        } else {
            // Non-overlapping - add current interval to union
            unionSeconds += (currentEnd - currentStart);
            currentStart = nextStart;
            currentEnd = nextEnd;
        }
    }
    unionSeconds += (currentEnd - currentStart);

    // Common time = total time - union time (overlapping portions)
    const commonTimeSeconds = Math.max(0, totalSeconds - unionSeconds);

    const hours = Math.floor(commonTimeSeconds / 3600);
    const minutes = Math.floor((commonTimeSeconds % 3600) / 60);
    const seconds = commonTimeSeconds % 60;

    return { hours, minutes, seconds };
}

/**
 * Calculate total duration from all timesheet entries
 */
function calculateTotalDuration(timesheets) {
    if (!timesheets || timesheets.length === 0) {
        return { hours: 0, minutes: 0, seconds: 0 };
    }

    const calculateDurationFromTimes = (startTime, stopTime) => {
        const timeToSeconds = (timeStr) => {
            if (!timeStr || timeStr === '-' || timeStr === 'Ongoing') return null;
            const match = timeStr.match(/^(\d{1,2}):(\d{2}):(\d{2})$/);
            if (!match) return null;
            const hours = parseInt(match[1], 10);
            const minutes = parseInt(match[2], 10);
            const seconds = parseInt(match[3], 10);
            return hours * 3600 + minutes * 60 + seconds;
        };

        const start = timeToSeconds(startTime);
        const stop = timeToSeconds(stopTime);

        if (start === null || stop === null || stop <= start) {
            return { hours: 0, minutes: 0, seconds: 0 };
        }

        const durationSeconds = stop - start;
        const hours = Math.floor(durationSeconds / 3600);
        const minutes = Math.floor((durationSeconds % 3600) / 60);
        const seconds = durationSeconds % 60;

        return { hours, minutes, seconds };
    };

    let totalSeconds = 0;
    timesheets.forEach(ts => {
        if (ts.start_time && ts.stop_time && ts.stop_time !== 'Ongoing') {
            const dur = calculateDurationFromTimes(ts.start_time, ts.stop_time);
            totalSeconds += dur.hours * 3600 + dur.minutes * 60 + dur.seconds;
        }
    });

    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    return { hours, minutes, seconds };
}

/**
 * Calculate net time (total duration - common time)
 */
function calculateNetTime(timesheets) {
    const totalDuration = calculateTotalDuration(timesheets);
    const commonTime = calculateCommonTime(timesheets);

    const totalSeconds = totalDuration.hours * 3600 + totalDuration.minutes * 60 + totalDuration.seconds;
    const commonSeconds = commonTime.hours * 3600 + commonTime.minutes * 60 + commonTime.seconds;
    const netSeconds = Math.max(0, totalSeconds - commonSeconds);

    const hours = Math.floor(netSeconds / 3600);
    const minutes = Math.floor((netSeconds % 3600) / 60);
    const seconds = netSeconds % 60;

    return { hours, minutes, seconds };
}

/**
 * Normalize date to YYYY-MM-DD for grouping (same date = same calendar day)
 */
function normalizeDateKey(dateVal) {
    if (dateVal == null || dateVal === '') return null;
    const s = String(dateVal).trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.substring(0, 10);
    const d = new Date(s);
    if (!isNaN(d.getTime())) {
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
    }
    return null;
}

/**
 * Union of intervals [[start,end],...] in seconds; returns total union seconds.
 */
function unionSecondsForIntervals(intervals) {
    if (!intervals || intervals.length === 0) return 0;
    const sorted = intervals.slice().sort((a, b) => a[0] - b[0]);
    let union = 0;
    let start = sorted[0][0];
    let end = sorted[0][1];
    for (let i = 1; i < sorted.length; i++) {
        const [s, e] = sorted[i];
        if (s < end) {
            end = Math.max(end, e);
        } else {
            union += (end - start);
            start = s;
            end = e;
        }
    }
    union += (end - start);
    return union;
}

/**
 * Net time with same-date rule: only same date + overlapping time counts as overlap.
 * Group by date, compute union per date, sum for total net.
 */
function calculateNetTimeByDate(timesheets) {
    if (!timesheets || timesheets.length === 0) {
        return { hours: 0, minutes: 0, seconds: 0 };
    }

    const timeToSeconds = (timeStr) => {
        if (!timeStr || timeStr === '-' || timeStr === 'Ongoing') return null;
        const match = timeStr.match(/^(\d{1,2}):(\d{2}):(\d{2})$/);
        if (!match) return null;
        return parseInt(match[1], 10) * 3600 + parseInt(match[2], 10) * 60 + parseInt(match[3], 10);
    };

    const byDate = new Map();
    let noDateIndex = 0;
    for (const entry of timesheets) {
        const start = timeToSeconds(entry.start_time);
        const stop = timeToSeconds(entry.stop_time);
        if (start === null || stop === null || stop <= start) continue;
        const dateKey = normalizeDateKey(entry.date) || `__no_date_${noDateIndex++}`;
        if (!byDate.has(dateKey)) byDate.set(dateKey, []);
        byDate.get(dateKey).push([start, stop]);
    }

    let netTotalSeconds = 0;
    for (const intervals of byDate.values()) {
        netTotalSeconds += unionSecondsForIntervals(intervals);
    }

    const hours = Math.floor(netTotalSeconds / 3600);
    const minutes = Math.floor((netTotalSeconds % 3600) / 60);
    const seconds = netTotalSeconds % 60;

    return { hours, minutes, seconds };
}
