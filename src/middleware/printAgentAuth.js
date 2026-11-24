import crypto from "node:crypto";

export const verifyPrintAgent = (req, res, next) => {
    const expected = process.env.PRINT_AGENT_TOKEN;
    const authorization = req.headers.authorization || "";

    const supplied = authorization.startsWith("Bearer ")
        ? authorization.slice(7)
        : "";

    if (!expected || !supplied) {
        return res.status(401).json({
            success: false,
            message: "Print Agent authentication required"
        });
    }

    const expectedBuffer = Buffer.from(expected, "utf8");
    const suppliedBuffer = Buffer.from(supplied, "utf8");

    if (
        expectedBuffer.length !== suppliedBuffer.length ||
        !crypto.timingSafeEqual(expectedBuffer, suppliedBuffer)
    ) {
        return res.status(401).json({
            success: false,
            message: "Invalid Print Agent credentials"
        });
    }

    next();
};