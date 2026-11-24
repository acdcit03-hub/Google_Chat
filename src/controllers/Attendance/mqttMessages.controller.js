import { getIO } from "../../config/socket.js";
import { getAllMQTTMessagesModel, insertMQTTMessageModel, updateAckStatusModel } from "../../models/Attendance/mqttMessages.model.js";

/* ================= SAVE MESSAGE ================= */
export const saveMQTTMessage = async (data) => {
    const saved = await insertMQTTMessageModel(data);

    try {
        const io = getIO();

        if (io) {
            io.emit("mqtt-messages:created", {
                success: true,
                message: "New MQTT message received",
                data: saved
            });
        }

    } catch (socketError) {
        console.error("SOCKET ERROR:", socketError.message);
    }

    return saved;
};

/* ================= UPDATE ACK ================= */
export const markMQTTAck = async (message_id) => {
    return await updateAckStatusModel(message_id);
};

/* ================= GET ALL ================= */
export const getMQTTMessages = async (req, res) => {
    try {
        const {
            work_location,
            location_id,
            device_time_from,
            device_time_to,
            received_time_from,
            received_time_to,
            mac_id,
            rfid,
            message_id,
            page,
            limit
        } = req.query;

        const result = await getAllMQTTMessagesModel({
            work_location,
            location_id,
            device_time_from,
            device_time_to,
            received_time_from,
            received_time_to,
            mac_id,
            rfid,
            message_id,
            page: Number(page) || 1,
            limit: Number(limit) || 20
        });

        /* ================= SOCKET ================= */
        const io = getIO();

        if (io) {
            io.emit("mqtt-messages:fetch", {
                success: true,
                message: "Mqtt messages fetched",
                data: result.rows
            });
        }

        return res.status(200).json({
            success: true,
            message: "MQTT messages fetched successfully",
            data: result.rows,
            pagination: result.pagination
        });

    } catch (error) {
        console.error("GET MQTT MESSAGES ERROR:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};