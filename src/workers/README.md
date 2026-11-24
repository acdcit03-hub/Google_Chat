# Worker Threads for API Performance

This directory contains worker thread scripts that run CPU-intensive operations in separate threads, allowing the main event loop to remain responsive and handle simultaneous API calls efficiently.

## How It Works

### Thread Communication Flow

1. **Main Thread** (API Controller):
   - Receives HTTP request
   - Calls `runInParallel()` or `workerPool.execute()` from `worker.utils.js`
   - Creates worker threads with data via `workerData`
   - Listens for results via `worker.on('message')`
   - Returns response to client

2. **Worker Thread** (Worker Script):
   - Receives data via `workerData` (available at initialization)
   - Performs CPU-intensive calculation
   - Sends result back via `parentPort.postMessage()`
   - Terminates when done

### Benefits

- **Non-blocking**: Heavy calculations don't block the main event loop
- **Parallel Processing**: Multiple workers can run simultaneously
- **Faster Response**: CPU-intensive tasks run in parallel threads
- **Better Scalability**: Can handle multiple concurrent requests

## Files

- **timesheet-calculations.worker.js**: Handles timesheet calculations (total duration, common time, net time)

## Usage Example

```javascript
const { runInParallel, workerPool } = require('../utils/worker.utils');

// Execute multiple operations in parallel
const results = await runInParallel([
    {
        workerFile: 'timesheet-calculations.worker.js',
        data: { timesheets: data, operation: 'calculateTotalDuration' }
    },
    {
        workerFile: 'timesheet-calculations.worker.js',
        data: { timesheets: data, operation: 'calculateCommonTime' }
    }
]);

// Or use worker pool for queued execution
const result = await workerPool.execute('timesheet-calculations.worker.js', {
    timesheets: data,
    operation: 'calculateNetTime'
});
```

## Current Integrations

- **Timesheet Summary API**: Uses parallel workers for calculating total duration, common time, and net time simultaneously
- **Project Net Time Calculation**: Uses worker pool for large datasets (>50 timesheets)
