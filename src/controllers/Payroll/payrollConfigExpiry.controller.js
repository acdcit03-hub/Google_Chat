import cron from "node-cron";
import { updatePayrollConfigStatusesModel } from "../../models/Payroll/employee_payroll_config.model.js";
// import {
//     emitPayrollExpiryNotifications,
//     createUpcomingSalaryIncrementNotifications,
//     emitUpcomingSalaryIncrementNotifications
// } from "../../utils/notification/payrollStatusNotify.js";

async function checkPayrollConfigExpiry() {
    try {
        await updatePayrollConfigStatusesModel();
        // Payroll expiry notification disabled
        // emitPayrollExpiryNotifications(result.expiryNotifications);
    } catch (error) {
        console.error("PAYROLL CONFIG EXPIRY CHECK ERROR:", error);
    }
}

export function startPayrollConfigExpiryCheck() {
    void checkPayrollConfigExpiry();

    cron.schedule("* * * * *", checkPayrollConfigExpiry, {
        timezone: "Asia/Kolkata"
    });

    /* Payroll salary-increment notifications disabled
    cron.schedule("* * * * *", async () => {
        try {
            const notifications =
                await createUpcomingSalaryIncrementNotifications();
            emitUpcomingSalaryIncrementNotifications(notifications);
        } catch (error) {
            console.error("SALARY INCREMENT NOTIFICATION CHECK ERROR:", error);
        }
    }, {
        timezone: "Asia/Kolkata"
    });
    */
}
