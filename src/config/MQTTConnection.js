import mqtt from "mqtt";
import dotenv from "dotenv";
import { saveMacAddress } from "../models/Attendance/mac_address.model.js";
import { sendHandshakeAck, sendRFIDAck } from "../controllers/services/mqttAckService.controller.js";
import { isDuplicateScanWithinOneMinute, saveAttendanceSession } from "../models/Attendance/attendance_session.model.js";
import { getDeviceStatusModel, markOfflineDevicesModel } from "../models/settings/DeviceConfigurations.model.js";
import { pool } from "./db.js";
import { getIO } from "./socket.js";
import { getUsernameByRFID } from "../models/Employee/EmploymentDetails.model.js";
import { saveMQTTMessage } from "../controllers/Attendance/mqttMessages.controller.js";
import os from "os";
import { updateDeviceVersionModel } from "../models/history/device_version_logs.model.js";
import { startDeviceTimeSync } from "../services/deviceTimeSync.service.js";

dotenv.config();

const DEVICE_PROJECT_CODE = process.env.DEVICE_PROJECT_CODE;

let client = null;
let mqttConnected = false;
const offlineMessageQueue = new Map();
const processingDevices = new Set();

/* ================= PARSE TIMESTAMP ================= */
function parseTimestamp(value) {
    if (!value) return null;
    const date = new Date(value);

    return isNaN(date.getTime())
        ? null
        : date;
}

function extractProjectCode(topic) {
    const parts = topic.split("/");
    return parts[0] || "unknown";
}

function extractMac(topic) {
    const parts = topic.split("/");
    return parts.length ? parts[1] : "unknown";
}

/* ================= PROCESS RFID SCAN ================= */
async function processRFIDScan(
    deviceMac,
    rfidUid,
    messageId,
    deviceTimestamp,
    rawPayload
) {
    try {
        const username = await getUsernameByRFID(rfidUid);
        console.log("RFID USERNAME:", username);

        // BLOCK attendance session for unregistered users
        if (!username || username.toLowerCase() === "unregistered") {

            console.log("================================");
            console.log("Device:", deviceMac);
            console.log("RFID:", rfidUid);
            console.log("Message ID:", messageId);
            console.log("Timestamp:", deviceTimestamp);
            console.log("Raw:", rawPayload);
            console.log("================================");
            console.log("⛔ Unregistered RFID - only MQTT log will be saved");

            return {
                ack: true,
                action: "unregistered_only_logged"
            };
        }

        const duplicate = await isDuplicateScanWithinOneMinute({
            username,
            deviceTimestamp
        });

        if (duplicate) {
            console.log(`⚠ Duplicate scan ignored (${username}) within 30 second`);
            return {
                ack: true,
                action: "duplicate_scan"
            };
        }

        // NORMAL FLOW (registered user)
        const attendance = await saveAttendanceSession({
            rfid: rfidUid,
            mac_id: deviceMac,
            message_id: messageId,
            deviceTimestamp
        });

        const io = getIO();

        if (io) {
            io.emit("attendance-update", {
                type: attendance.action,
                data: attendance.data
            });
        }

        return {
            ack: true,
            action: attendance.action,
        };

    } catch (error) {
        console.error(error);
        return {
            ack: false,
            action: "error",
        };
    }
}

/* ================= SET INTERVAL ================= */
setInterval(async () => {
    try {
        const offlineDevices = await markOfflineDevicesModel();

        if (offlineDevices.length > 0) {
            console.log(
                `🔴 ${offlineDevices.length} device(s) marked OFFLINE at ${new Date().toLocaleString(
                    "en-IN",
                    {
                        timeZone: "Asia/Kolkata"
                    }
                )} | MAC IDs: ${offlineDevices
                    .map(d => d.mac_id)
                    .join(", ")}`
            );
        }

    } catch (err) {
        console.error("Offline Check Error:", err);
    }
}, 1000);

/* ================= PROCESS QUEUED MSG ================= */
async function processQueuedMessages(projectCode, deviceMac) {
    const queuedMessages = offlineMessageQueue.get(deviceMac) || [];
    if (!queuedMessages.length) {
        return;
    }

    console.log(`\n🟢 Device ${deviceMac} ONLINE - Processing ${queuedMessages.length} queued logs\n`);

    for (const item of queuedMessages) {
        try {
            const {
                data,
                rfidUid,
                messageId,
                deviceTimestamp
            } = item;

            console.log(`📦 Processing Queued RFID -> ${rfidUid}`);

            const result = await processRFIDScan(
                deviceMac,
                rfidUid,
                messageId,
                deviceTimestamp,
                data
            );

            await saveMQTTMessage({
                mac_id: deviceMac,
                rfid_uid: rfidUid,
                message_id: messageId,
                device_timestamp: deviceTimestamp,
                ack_sent: result?.ack ?? false,
                raw_payload: data
            });

            if (
                client &&
                result?.ack !== false
            ) {
                client.publish(
                    `${DEVICE_PROJECT_CODE}/${deviceMac}/sub`,
                    JSON.stringify({
                        ack: true,
                        message_id: messageId,
                        action:
                            result?.action ||
                            "attendance_recorded"
                    }),
                    { qos: 1 }
                );
            }

        } catch (error) {
            console.error("Queue Process Error:", error);
        }
    }
    offlineMessageQueue.delete(deviceMac);
}

/* ================= CONNECT MQTT ================= */
export const connectMQTT = () => {

    const protocol =
        process.env.MQTT_USE_SSL === "true"
            ? "mqtts"
            : "mqtt";

    const clientId = `attendance_${os.hostname()}_${process.pid}_${Date.now()}`;

    client = mqtt.connect(
        `${protocol}://${process.env.MQTT_HOST}:${process.env.MQTT_PORT}`,
        {
            clientId,
            username: process.env.MQTT_USER || undefined,
            password: process.env.MQTT_PASSWORD || undefined,
            reconnectPeriod: 5000,
            rejectUnauthorized: false,
        }
    );

    client.on("connect", () => {
        mqttConnected = true;
        startDeviceTimeSync(client, () => mqttConnected);

        const topics = [
            "+/+/pub",
            "+/+/handshake",
            "+/+/status/ack"
        ];

        client.subscribe(
            topics,
            { qos: 1 },
            (err) => {
                if (err) {
                    console.log("❌ Subscribe Error:", err.message);
                } else {
                    console.log(`✅ Subscribed -> ${topics.join(", ")}`);
                }
            }
        );
    });

    client.on("message", async (topic, message) => {

        const raw = message.toString();
        const projectCode = extractProjectCode(topic);
        const deviceMac = extractMac(topic);
        let data;

        try {
            data = JSON.parse(raw);

            if (
                topic.endsWith("/pub") &&
                Number(data.msg_id) === 10 &&
                Number(data.cmd) === 901
            ) {
                return;
            }

            console.log("📩 MQTT MESSAGE RECEIVED");
            console.log("Topic:", topic);
            console.log("Project Code:", projectCode);
            console.log(data);

        } catch (error) {
            console.log("⚠ Invalid JSON:", raw);
            return;
        }

        /* ================= HANDSHAKE STATUS ACK ================= */
        if (topic.endsWith("/status/ack")) {
            console.log("================================");
            console.log("Handshake Status ACK Received");
            console.log(data);
            console.log("================================");

            const {
                msg_id,
                mac_id,
                received,
                recive
            } = data;

            const ackReceived = received ?? recive;

            if (ackReceived === true) {

                await pool.query(`
                    UPDATE device_configurations
                    SET connection = 'online',
                        updated_at = NOW()
                    WHERE mac_id = $1
                `, [mac_id]);

                console.log(`✅ Status ACK received`);
                console.log(`Message ID : ${msg_id}`);
                console.log(`MAC ID     : ${mac_id}`);
                console.log(`✅ ${mac_id} marked ONLINE`);
            } else {
                console.log("❌ Status ACK not received");
            }

            return;
        }

        /* ================= HANDSHAKE ================= */
        if (topic.endsWith("/handshake")) {
            console.log("================================");
            console.log("🏓 HEARTBEAT RECEIVED");
            console.log("Device :", deviceMac);
            console.log("Time   :", new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }));
            console.log("================================");

            try {
                const status = await getDeviceStatusModel(deviceMac);
                if (!status) {
                    console.log(`\nDevice disabled -> sending handshake reject`);

                    sendHandshakeAck(DEVICE_PROJECT_CODE, deviceMac, data, false);
                    return;
                }

                const deviceIp =
                    data.ip ||
                    data.ip_address ||
                    data.ipAddress ||
                    null;

                await saveMacAddress(deviceMac);
                await updateDeviceVersionModel(
                    deviceMac,
                    data.version,
                    deviceIp
                );
                await processQueuedMessages(projectCode, deviceMac);

                sendHandshakeAck(
                    DEVICE_PROJECT_CODE,
                    deviceMac,
                    data,
                    status
                );

            } catch (error) {
                console.error("handshake Error:", error);
                sendHandshakeAck(
                    DEVICE_PROJECT_CODE,
                    deviceMac,
                    data,
                    false
                );
            }

            return;
        }

        /* ================= RFID PUB ================= */
        const rfidUid = String(data.rfid_uid || "").trim();
        const messageId = Number(data.message_id || 0);
        const deviceTimestamp = parseTimestamp(data.timestamp);

        const deviceResult = await pool.query(
            `
                SELECT connection, status
                FROM device_configurations
                WHERE mac_id = $1
                LIMIT 1
            `,
            [deviceMac]
        );

        const device = deviceResult.rows[0];
        const connection = deviceResult.rows[0]?.connection || "offline";
        const status = device?.status ?? true;

        if (status === false && connection === "offline") {
            console.log(`⛔ STRICT MODE: MQTT ONLY (offline + disabled)`);

            await saveMQTTMessage({
                mac_id: deviceMac,
                rfid_uid: rfidUid,
                message_id: messageId,
                device_timestamp: deviceTimestamp,
                ack_sent: false,
                raw_payload: data
            });

            client.publish(
                `${DEVICE_PROJECT_CODE}/${deviceMac}/sub`,
                JSON.stringify({
                    ack: false,
                    message_id: messageId,
                    action: "device_disabled_offline"
                }),
                { qos: 1 }
            );

            return;
        }

        if (status === false) {
            console.log(`⛔ Device disabled (status=false) -> ${deviceMac}`);

            client.publish(
                `${DEVICE_PROJECT_CODE}/${deviceMac}/sub`,
                JSON.stringify({
                    ack: false,
                    message_id: messageId,
                    action: "device_disabled"
                }),
                { qos: 1 }
            );

            return;
        }

        /* ================= VALIDATE RFID ================= */
        if (!rfidUid) {
            console.log(`⚠ Missing rfid_uid on ${topic}`);
            return;
        }

        /* ================= DUPLICATE PROCESS CHECK ================= */
        if (processingDevices.has(deviceMac)) {
            return;
        }

        processingDevices.add(deviceMac);

        try {
            const deviceTimestamp = parseTimestamp(data.timestamp);

            /* ===== PROCESS RFID FIRST ===== */
            const result = await processRFIDScan(
                deviceMac,
                rfidUid,
                messageId,
                deviceTimestamp,
                data
            );

            /* ===== SAVE INTO DB ===== */
            await saveMQTTMessage({
                mac_id: deviceMac,
                rfid_uid: rfidUid,
                message_id: messageId,
                device_timestamp: deviceTimestamp,
                ack_sent: result?.ack ?? false,
                raw_payload: data
            });

            /* ===== SEND ACK ONLY IF SUCCESS ===== */
            if (result?.ack !== false) {
                client.publish(
                    `${DEVICE_PROJECT_CODE}/${deviceMac}/sub`,
                    JSON.stringify({
                        ack: true,
                        message_id: messageId,
                        action: result?.action || "attendance_recorded"
                    }),
                    { qos: 1 }
                );
            } else {
                console.log("⚠ RFID processing failed, ACK not sent");
            }

        } catch (err) {
            console.error("MQTT ERROR:", err);
            client.publish(
                `${DEVICE_PROJECT_CODE}/${deviceMac}/sub`,
                JSON.stringify({
                    ack: false,
                    message_id: messageId
                }),
                { qos: 1 }
            );

        } finally {
            processingDevices.delete(
                deviceMac
            );
        }
    });


    client.on("disconnect", () => {
        mqttConnected = false;
        console.log("⚠ MQTT Disconnected");
    });

    client.on("close", () => {
        mqttConnected = false;
        console.log("⚠ MQTT Connection Closed");
    });

    client.on("error", (err) => {
        mqttConnected = false;
        console.log("❌ MQTT Error:", err.message);
    });

    client.on("reconnect", () => {
        console.log("🔄 MQTT Reconnecting...");
    });

    client.on("offline", () => {
        mqttConnected = false;
        console.log("📴 MQTT Offline");
    });

    return client;
};

export const getMQTTClient = () => client;
export const isMQTTConnected = () => mqttConnected;