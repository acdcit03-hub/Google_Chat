const TIME_SYNC_TOPIC = "time/sync/atten";
const TIME_SYNC_PAYLOAD = JSON.stringify({
    msg_id: 10,
    cmd: 901,
    data: {}
});

let timeSyncInterval = null;

function getTimeSyncIntervalMs() {
    const configuredSeconds = Number(process.env.DEVICE_TIME_SYNC_INTERVAL_SECONDS);

    if (!Number.isFinite(configuredSeconds) || configuredSeconds <= 0) {
        throw new Error("DEVICE_TIME_SYNC_INTERVAL_SECONDS must be a positive number");
    }

    return configuredSeconds * 1000;
}

export function startDeviceTimeSync(client, isConnected) {
    if (timeSyncInterval) {
        return;
    }

    const intervalMs = getTimeSyncIntervalMs();

    timeSyncInterval = setInterval(() => {
        if (!isConnected()) {
            return;
        }

        client.publish(
            TIME_SYNC_TOPIC,
            TIME_SYNC_PAYLOAD,
            { qos: 0 },
            (error) => {
                if (error) {
                    console.error(`Device time sync publish failed on ${TIME_SYNC_TOPIC}:`, error.message);
                } else {
                    console.log("================================");
                    console.log("⏰ DEVICE TIME SYNC PUBLISHED");
                    console.log("Topic:", TIME_SYNC_TOPIC);
                    console.log("Time:", new Date().toLocaleString("en-IN", {
                        timeZone: "Asia/Kolkata"
                    }));
                    console.log(JSON.parse(TIME_SYNC_PAYLOAD));
                    console.log("================================");
                }
            }
        );
    }, intervalMs);
}
