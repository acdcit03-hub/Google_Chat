export const sanitizeBody = (req, res, next) => {
    if (!req.body || typeof req.body !== "object") {
        req.body = {};
        return next();
    }

    for (let key in req.body) {
        if (typeof req.body[key] === "string") {
            req.body[key] = req.body[key].trim().replace(/\s+/g, " ");
        }
    }
    next();
};