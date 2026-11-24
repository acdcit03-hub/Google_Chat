/**
 * Centralized Express error helpers + middleware.
 *
 * Usage in routes/controllers:
 *   throw new AppError('Not found', 404);
 *   next(new AppError('Forbidden', 403));
 *   router.get('/x', asyncHandler(async (req, res) => { ... }));
 *
 * Register last in server.js:
 *   app.use(notFoundHandler);
 *   app.use(errorHandler);
 */

/** Operational HTTP error with status code. */
export class AppError extends Error {
    constructor(message, statusCode = 500, details = null) {
        super(message);
        this.name = 'AppError';
        this.statusCode = Number(statusCode) || 500;
        this.details = details;
        this.isOperational = true;
        Error.captureStackTrace?.(this, this.constructor);
    }
}

/** Wrap async route handlers so rejected promises reach errorHandler. */
export function asyncHandler(fn) {
    return (req, res, next) => {
        Promise.resolve(fn(req, res, next)).catch(next);
    };
}

/**
 * Wrap listed static methods on a controller class with asyncHandler.
 * Call once after the class is defined, before export.
 *
 * @example
 * wrapController(ClientController, ['getAllClients', 'createClient']);
 * export default ClientController;
 */
export function wrapController(Controller, methodNames) {
    for (const name of methodNames) {
        const fn = Controller[name];
        if (typeof fn !== 'function') {
            throw new Error(`wrapController: ${Controller.name}.${name} is not a function`);
        }
        Controller[name] = asyncHandler(fn.bind(Controller));
    }
    return Controller;
}

/** 404 for unmatched routes — place after all routers. */
export function notFoundHandler(req, res, next) {
    next(new AppError(`Route ${req.originalUrl} not found`, 404));
}

function resolveStatusCode(err) {
    if (err?.statusCode && Number.isFinite(Number(err.statusCode))) {
        return Number(err.statusCode);
    }
    if (err?.status && Number.isFinite(Number(err.status))) {
        return Number(err.status);
    }

    // Common library / DB codes
    if (err?.name === 'ValidationError') return 400;
    if (err?.name === 'UnauthorizedError') return 401;
    if (err?.code === '23505') return 409; // Postgres unique violation
    if (err?.code === '23503') return 400; // Postgres foreign key
    if (err?.code === '22P02') return 400; // invalid input syntax
    if (err?.code === 'LIMIT_UNEXPECTED_FILE') return 400;
    if (err?.code === 'LIMIT_FILE_SIZE') return 400;

    return 500;
}

function resolveMessage(err, statusCode) {
    if (err instanceof AppError || err?.isOperational) {
        return err.message || 'Request failed';
    }
    if (statusCode < 500 && err?.message) {
        return err.message;
    }
    if (process.env.NODE_ENV === 'production') {
        return 'Internal server error';
    }
    return err?.message || 'Internal server error';
}

/**
 * Express error middleware (must have 4 args).
 * Place after notFoundHandler / all routes.
 */
export function errorHandler(err, req, res, next) {
    if (res.headersSent) {
        return next(err);
    }

    const statusCode = resolveStatusCode(err);
    const message = resolveMessage(err, statusCode);

    if (statusCode >= 500) {
        console.error('[error]', {
            method: req.method,
            url: req.originalUrl,
            message: err?.message,
            field: err?.field,
            stack: err?.stack,
        });
    }

    const body = {
        success: false,
        message,
    };

    if (err?.details != null) {
        body.details = err.details;
    }

    if (process.env.NODE_ENV !== 'production' && err?.stack) {
        body.stack = err.stack;
    }

    return res.status(statusCode).json(body);
}

export default errorHandler;
