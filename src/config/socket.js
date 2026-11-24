import { Server } from 'socket.io';

let io;

const init = (server) => {
    io = new Server(server, {
        cors: {
            origin: true, // Allow all origins in production, or specify your frontend URL
            credentials: true,
            methods: ['GET', 'POST', 'PUT', 'DELETE']
        },
        transports: ['websocket', 'polling'], // Support both transports
        allowEIO3: true, // Allow Engine.IO v3 clients for backward compatibility
        pingTimeout: 60000, // Increase ping timeout for production
        pingInterval: 25000, // Increase ping interval
        upgradeTimeout: 30000, // Increase upgrade timeout
        maxHttpBufferSize: 1e8, // 100MB buffer size
        connectTimeout: 45000, // Connection timeout
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
        reconnectionAttempts: Infinity // Keep trying to reconnect
    });

    io.on('connection', (socket) => {
        console.log('New client connected:', socket.id);

        socket.on('disconnect', (reason) => {
            console.log('Client disconnected:', socket.id, 'Reason:', reason);
        });

        socket.on('error', (error) => {
            console.error('Socket error:', error);
        });
    });

    // Handle connection errors
    io.engine.on('connection_error', (err) => {
        console.error('Socket.IO connection error:', err);
    });

    return io;
};

const getIO = () => {
    // Return undefined if not initialized instead of throwing
    // This allows calling code to handle the absence gracefully
    return io;
};

const broadcast = (event, type, data) => {
    if (io) {
        io.emit(event, { type, data });
    }
};

// Specific broadcast functions for different entities
const broadcastRequirementUpdate = (type, data) => {
    if (io) {
        io.emit('requirement-update', { type, data });
    }
};

const broadcastClientUpdate = (type, data) => {
    if (io) {
        io.emit('client-update', { type, data });
    }
};

const broadcastProjectUpdate = (type, data) => {
    if (io) {
        io.emit('project-update', { type, data });
    }
};

const broadcastTimesheetUpdate = (type, data) => {
    if (io) {
        io.emit('timesheet-update', { type, data });
    }
};

const broadcastEmployeePayrollConfigUpdate = (type, data) => {
    broadcast('employee-payroll-config-update', type, data);
};

const broadcastEmployeePayrollConfigRead = (type, data) => {
    broadcast('employee-payroll-config-read', type, data);
};

const connectedClientCount = () => {
    if (!io) return 0;
    try {
        return io.engine?.clientsCount ?? io.sockets?.sockets?.size ?? 0;
    } catch {
        return 0;
    }
};

const logQtyReservationEmit = (event, type, data) => {
    const id = data?.id ?? data?.notification?.id ?? null;
    const username = data?.username ?? data?.receive_username ?? null;
    console.log(`[socket] emit ${event}`, {
        type,
        id,
        username,
        clients: connectedClientCount(),
    });
};

const broadcastQtyReservationUpdate = (type, data) => {
    if (!io) {
        console.warn('[socket] skip qty-reservation-update — Socket.IO not initialized');
        return;
    }
    logQtyReservationEmit('qty-reservation-update', type, data);
    io.emit('qty-reservation-update', { type, data });
};

/**
 * Emitted when a user's profile (name, department, etc.) is updated.
 * Clients whose logged-in username matches update their header live.
 */
const broadcastUserProfileUpdated = (username, fields = {}) => {
    if (io && username) {
        io.emit('user-profile-updated', { username, ...fields });
    }
};

/** Emitted when a user successfully logs in. */
const broadcastUserLogin = (username, department, id) => {
    if (io) {
        io.emit('user-login', { type: 'logged-in', data: { username, department, id } });
    }
};

/** Completed-review notifications (GET /api/qty-reservations/notifications). */
const broadcastQtyReservationNotification = (type, data) => {
    if (!io) {
        console.warn('[socket] skip qty-reservation-notification — Socket.IO not initialized');
        return;
    }
    logQtyReservationEmit('qty-reservation-notification', type, data);
    io.emit('qty-reservation-notification', { type, data });
};

const broadcastForceLogout = (username) => {
    if (io) {
        io.emit('force-logout', { username });
    }
};

export {
    init,
    getIO,
    broadcast,
    broadcastRequirementUpdate,
    broadcastClientUpdate,
    broadcastProjectUpdate,
    broadcastTimesheetUpdate,
    broadcastEmployeePayrollConfigUpdate,
    broadcastEmployeePayrollConfigRead,
    broadcastQtyReservationUpdate,
    broadcastQtyReservationNotification,
    broadcastUserLogin,
    broadcastUserProfileUpdated,
    broadcastForceLogout
};

export default {
    init,
    getIO,
    broadcast,
    broadcastRequirementUpdate,
    broadcastClientUpdate,
    broadcastProjectUpdate,
    broadcastTimesheetUpdate,
    broadcastEmployeePayrollConfigUpdate,
    broadcastEmployeePayrollConfigRead,
    broadcastQtyReservationUpdate,
    broadcastQtyReservationNotification,
    broadcastUserLogin,
    broadcastUserProfileUpdated,
    broadcastForceLogout
};
