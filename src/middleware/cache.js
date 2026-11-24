const CACHE_CONTROL = {
    noStore: 'no-store',
    revalidate: 'private, max-age=0, must-revalidate',
    privateShort: 'private, max-age=300',
    privateLong: 'private, max-age=86400, immutable',
    publicShort: 'public, max-age=300',
    publicLong: 'public, max-age=86400, immutable',
};

function cacheControl(value = CACHE_CONTROL.privateShort) {
    return (_req, res, next) => {
        res.setHeader('Cache-Control', value);
        next();
    };
}

function fastApiMiddleware(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.setHeader('Cache-Control', CACHE_CONTROL.noStore);
        next();
        return;
    }

    res.setHeader('Cache-Control', CACHE_CONTROL.revalidate);
    next();
}

export {
    CACHE_CONTROL,
    cacheControl,
    fastApiMiddleware,
};
