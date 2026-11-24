import cron from "node-cron";
import { expireAttendanceModel, getAttendanceToAutoClose } from "../../../models/Attendance/AutoCloseAttendance/AutoCloseAttendance.model.js";
import { deleteOpenSession } from "../../../models/Attendance/open_sessions.model.js";
import { addAttendanceLogModel } from "../../../models/history/attendance_logs.model.js";

console.log("✅ Auto Close Attendance Cron Started");

cron.schedule("* * * * *", async () => {
    try {
        const sessions = await getAttendanceToAutoClose();

        const now = new Date(
            new Date().toLocaleString("en-US", {
                timeZone: "Asia/Kolkata"
            })
        );

        for (const session of sessions) {

            if (!session.shift_reset_time) continue;

            const entry = new Date(
                new Date(session.entry_at).toLocaleString("en-US", {
                    timeZone: "Asia/Kolkata"
                })
            );

            const [hour, minute] = session.shift_reset_time
                .split(":")
                .map(Number);

            // Reset corresponding to entry date
            let reset = new Date(entry);
            reset.setHours(hour, minute, 0, 0);

            // If entry happened AFTER reset,
            // expire at NEXT day's reset
            if (entry >= reset) {
                reset.setDate(reset.getDate() + 1);
            }

            // Expire only after reset time is reached
            if (now >= reset) {
                await expireAttendanceModel(session.id);

                await addAttendanceLogModel({
                    type: "edit",
                    username: session.username,
                    user_at: "SYSTEM",
                    old_value: {
                        status: "inside"
                    },
                    new_value: {
                        status: "Expired",
                        message: `Attendance automatically expired at ${reset.toLocaleString("en-IN")}`
                    }
                });

                await deleteOpenSession(session.id);
                console.log(`✅ Attendance expired : ${session.username}`);
            }
        }

    } catch (err) {
        console.error("Auto Close Error:", err);
    }
}); 