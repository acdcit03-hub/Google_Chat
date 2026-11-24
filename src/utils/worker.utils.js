import { Worker } from 'worker_threads';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Worker Thread Utility
 * 
 * This utility manages worker threads for CPU-intensive operations,
 * allowing the main event loop to remain responsive during heavy calculations.
 * 
 * Thread Communication:
 * - Main thread sends data via: new Worker(workerFile, { workerData: {...} })
 * - Worker receives data via: workerData (available at initialization)
 * - Worker sends result back via: parentPort.postMessage({...})
 * - Main thread receives result via: worker.on('message', (data) => {...})
 */

/**
 * Execute a task in a worker thread
 * @param {string} workerFile - Path to the worker script file
 * @param {object} data - Data to send to the worker
 * @param {number} timeout - Timeout in milliseconds (default: 30000)
 * @returns {Promise<object>} Result from the worker thread
 */
function runInWorker(workerFile, data, timeout = 30000) {
    return new Promise((resolve, reject) => {
        const workerPath = path.join(__dirname, '..', 'workers', workerFile);
        
        // Create a new worker thread
        // Each worker runs in a separate thread with its own V8 instance
        const worker = new Worker(workerPath, {
            workerData: data
        });

        let isResolved = false;

        // Listen for messages from the worker thread
        // This is how the worker sends data back to the main thread
        worker.on('message', (message) => {
            if (isResolved) return;
            isResolved = true;

            if (message.error) {
                reject(new Error(message.error));
            } else {
                resolve(message);
            }

            // Terminate the worker after receiving the result
            worker.terminate().catch(err => {
                console.error('[Worker Utils] Error terminating worker:', err);
            });
        });

        // Handle errors from the worker thread
        worker.on('error', (error) => {
            if (isResolved) return;
            isResolved = true;
            console.error('[Worker Utils] Worker thread error:', error);
            reject(error);
            worker.terminate().catch(() => {});
        });

        // Handle worker thread exit
        worker.on('exit', (code) => {
            if (code !== 0 && !isResolved) {
                isResolved = true;
                console.error(`[Worker Utils] Worker stopped with exit code ${code}`);
                reject(new Error(`Worker stopped with exit code ${code}`));
            }
        });

        // Set timeout to prevent infinite waiting
        const timeoutId = setTimeout(() => {
            if (!isResolved) {
                isResolved = true;
                worker.terminate();
                reject(new Error(`Worker thread timeout after ${timeout}ms`));
            }
        }, timeout);

        // Clear timeout if resolved early
        worker.on('message', () => clearTimeout(timeoutId));
        worker.on('error', () => clearTimeout(timeoutId));
    });
}

/**
 * Execute multiple tasks in parallel using worker threads
 * This allows simultaneous processing of multiple heavy calculations
 * @param {Array<{workerFile: string, data: object}>} tasks - Array of tasks to execute
 * @param {number} timeout - Timeout per worker in milliseconds
 * @returns {Promise<Array>} Array of results from all workers
 */
async function runInParallel(tasks, timeout = 30000) {
    // Execute all workers in parallel using Promise.all
    // Each worker runs in its own thread, allowing true parallel execution
    const promises = tasks.map(task => 
        runInWorker(task.workerFile, task.data, timeout)
            .catch(error => ({
                error: error.message,
                workerFile: task.workerFile
            }))
    );

    return Promise.all(promises);
}

/**
 * Worker Pool Manager
 * Manages a pool of worker threads for better performance and resource management
 */
class WorkerPool {
    constructor(maxWorkers = 4) {
        this.maxWorkers = maxWorkers;
        this.activeWorkers = 0;
        this.queue = [];
    }

    /**
     * Execute a task using the worker pool
     * If all workers are busy, the task is queued
     */
    async execute(workerFile, data, timeout = 30000) {
        return new Promise((resolve, reject) => {
            this.queue.push({ workerFile, data, timeout, resolve, reject });
            this.processQueue();
        });
    }

    /**
     * Process the queue of tasks
     */
    async processQueue() {
        // Don't process if queue is empty or all workers are busy
        if (this.queue.length === 0 || this.activeWorkers >= this.maxWorkers) {
            return;
        }

        const task = this.queue.shift();
        this.activeWorkers++;

        try {
            const result = await runInWorker(task.workerFile, task.data, task.timeout);
            task.resolve(result);
        } catch (error) {
            task.reject(error);
        } finally {
            this.activeWorkers--;
            // Process next task in queue
            this.processQueue();
        }
    }
}

// Create a singleton worker pool instance
const workerPool = new WorkerPool(parseInt(process.env.MAX_WORKER_THREADS) || 4);

export {
    runInWorker,
    runInParallel,
    workerPool,
    WorkerPool
};
