import { getMQTTClient } from "../../config/MQTTConnection.js";

const DEVICE_PROJECT_CODE = process.env.DEVICE_PROJECT_CODE;

export function sendRFIDAck(projectCode, deviceMac, messageId) {
    const client = getMQTTClient();

    if (!client) {
        console.log("MQTT Client not available");
        return;
    }

    if (!projectCode || !deviceMac) {
        console.log("Project Code or MAC ID missing");
        return;
    }

    const ackTopic = `${DEVICE_PROJECT_CODE}/${deviceMac}/sub`;

    const payload = JSON.stringify({
        ack: true,
        message_id: messageId,
    });

    client.publish(
        ackTopic,
        payload,
        { qos: 1 },
        (err) => {
            if (err) {
                console.log("ACK Publish Error:", err.message);
            } else {
                console.log(`ACK Sent -> ${ackTopic}`);
            }
        }
    );
}

/* ================= AUTO GENERATE MESSAGE ID ================= */
const generateMessageId = () => {
    return Math.floor(100000 + Math.random() * 900000);
};

/* ================= HANDSHAKE ACK ================= */
export function sendHandshakeAck(projectCode, deviceMac, data, status = true) {
    const client = getMQTTClient();

    if (!client) {
        console.log("MQTT Client not available");
        return;
    }

    if (!projectCode || !deviceMac) {
        console.log("Project Code or MAC ID missing");
        return;
    }

    const msgId = generateMessageId();

    const payload = {
        msg_id: msgId,
        mac_id: deviceMac,
        status: status
    };

    // Handshake ACK
    client.publish(
        `${projectCode}/${deviceMac}/handshake/ack`,
        JSON.stringify(payload),
        { qos: 1 }
    );

    console.log(`Handshake ACK Sent -> ${projectCode}/${deviceMac}/handshake/ack`);
    console.log(JSON.stringify(payload, null, 2));

    // Status
    client.publish(
        `${projectCode}/${deviceMac}/status`,
        JSON.stringify(payload),
        { qos: 1 }
    );

    console.log(`Status Sent -> ${projectCode}/${deviceMac}/status`);
    console.log(JSON.stringify(payload, null, 2));
}