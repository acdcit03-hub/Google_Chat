import dotenv from 'dotenv';
dotenv.config();
import express from 'express';
import http from 'http';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import { initializeDatabase, initializeTableSafely } from './database.js';
import apiRoutes from './routes/index.js';
import socketConfig from './config/socket.js';
import { attachUserFromToken } from './middleware/auth.js';
import { errorHandler, notFoundHandler } from './middleware/error.middleware.js';
import { initializeAttendanceSessionsTable } from './models/Attendance/attendance_session.model.js';
import { initializeMacAddressTable } from './models/Attendance/mac_address.model.js';
import { initializeMqttMessagesTable } from './models/Attendance/mqttMessages.model.js';
import { initializeOpenSessionsTable } from './models/Attendance/open_sessions.model.js';
import { initializeBankDetailsTable } from './models/Employee/BankDetails.model.js';
import { initializeEducationalQualificationsTable } from './models/Employee/EducationalQualifications.models.js';
import { initializeEmploymentDetailsTable } from './models/Employee/EmploymentDetails.model.js';
import { initializeIdentificationDetailsTable } from './models/Employee/IdentificationDetails.model.js';
import { initializePersonalDetailsTable } from './models/Employee/PersonalDetails.model.js';
import { initializeSalaryTable } from './models/Employee/SalaryDetails.models.js';
import { connectMQTT } from './config/MQTTConnection.js';
import { initializeBondOptionTable } from './models/settings/Bond.model.js';
import { initializeDepartmentsTable } from './models/settings/Deparments.model.js';
import { initializeDeviceConfigurationsTable } from './models/settings/DeviceConfigurations.model.js';
import { initializeLocationTable } from './models/settings/Location.model.js';
import { initializeShiftTable } from './models/settings/ShiftConfigurations.model.js';
import { initializeMasterEmployeeTable } from './models/Employee/MasterEmployee.model.js';
import { initializeWorkExperienceTable } from './models/Employee/WorkExperience.model.js';
import { initializeDepartmentStructureTable } from './models/settings/Department_structure.model.js';
import { initializeAttendanceLogsTable } from './models/history/attendance_logs.model.js';
import { initializeHolidaysTable } from './models/Attendance/Calendar/holiday.model.js';
import { initializeEmployeeLeavesTable } from './models/Attendance/EmployeeRecord/EmployeeLeaves.model.js';
import TaskModel from './models/timesheet/task.model.js';
import {
    initializeTaskStatusHistoryTable,
    initializeTaskStatusReasonTable,
} from './models/timesheet/taskStatusHistory.model.js';
import { initializeTaskLogTable } from './models/history/Tasklog.model.js';
import TaskStatusModel from './models/timesheet/taskStatus.model.js';
import "./controllers/Attendance/AutoCloseAttendance/AutoCloseAttendance.controller.js";
import "./controllers/timesheet/AutoStopTimesheet.controller.js";
import "./controllers/r2r/qtyReservationExpire.controller.js";
import swaggerUi from "swagger-ui-express";
import swaggerSpec from './config/swagger.js';
import compression from 'compression';
import { initializeInactiveEmployeeTable } from './models/Employee/inactive_employee.model.js';
import { initializeMaintenanceTable } from './models/Maintenance/Maintenance.model.js';
import { initializeCategoryTable } from './models/settings/category.model.js';
import { initializeEducationTable } from './models/settings/education.model.js';
import { initializeDeviceVersionLogsTable } from './models/history/device_version_logs.model.js';
import { initializeMasterPasswordTable } from './models/auth/MasterPassword.model.js';
import { initializeSettingLogsTable } from './models/history/setting_edit_log.model.js';
import { initializePayrollEditLogTable } from './models/history/payroll_edit_log.model.js';
import { initializeUserSessionEditLogTable } from './models/history/user_session_edit_log.model.js';
import { initializeLeaveEditLogTable } from './models/history/leave_edit_log.model.js';
import { initializeMeetingEditLogTable } from './models/history/meeting_edit_log.model.js';
import { initializeCalendarEditLogTable } from './models/history/calendar_log.model.js';
import { initializeEmployeeEditLogTable } from './models/history/employee_edit_log.model.js';
import { initializeRequirementEditLogTable } from './models/r2r/requirementEditLog.model.js';
import { initializeRequirementStatusTable } from './models/r2r/requirementStatus.model.js';
import R2rTempBomImageModel from './models/r2r/r2rTempBomImage.model.js';
import { initializeBomGoogleSheetTable } from './models/r2r/bomGoogleSheet.model.js';
import { initializeStatusTable } from './models/status/status.model.js';
import { initializeCandidateTable } from './models/Candidate/candidate.models.js';
import { initializeCandidateBoardPreferenceTable } from './models/Candidate/candidateBoardPreference.model.js';
import { initializeCandidateSourceTable } from './models/Candidate/candidate_source.model.js';
import { initializeJobPositionTable } from './models/JobPosition/jobPosition.models.js';
import { initializeMeetingScheduleTable } from './models/MeetingSchedule/meetingSchedule.models.js';
import { initializeFileManagerTable } from './models/filemanager/fileManager.model.js';
import { initializeFileManagerItemFolderUsersTable } from './models/filemanager/fileManagerItemFolderUsers.model.js';
import { initializeProjectFileManagerTables } from './models/filemanager/projectFileManager.model.js';
import { initializeFileManagerSettingTable } from './models/filemanager/fileManagerSetting.model.js';
import { initializeFileManagerLogTable } from './models/filemanager/fileManagerLog.model.js';
import { initializeCategoriesFolderStructureTable } from './models/filemanager/categoriesFolderStructure.model.js';
import { initializeUnifiedFileManagerSchema } from './models/filemanager/fileManagerUnified.schema.js';
import {
    initializeFinancialYearFileManagerTable,
    ensureFinancialYearFolders,
} from './models/filemanager/financialYearFileManager.model.js';
import { syncProjectFileManagerFromDisk } from './controllers/filemanager/projectFileManager.controller.js';
import { initializeSystemGuideTables } from './models/systemGuide/systemGuide.schema.js';
import { initializeLeaveTable } from './models/settings/Leave.model.js';
import { initializeLeavePriorTable } from './models/settings/Leave_prior.model.js';
import { initializeEmployeeMeetingTable } from './models/MeetingSchedule/employeeMeeting.models.js';
import { initializeProjectPcbVersionTable } from './models/projectsheet/projectPcbVersion.model.js';
import { initializeProjectLogTable } from './models/projectsheet/projectLog.model.js';
import { initializePcbLogTable } from './models/projectsheet/pcbLog.model.js';
import { initializeProductionLogTable } from './models/projectsheet/productionLog.model.js';
import { initializeEmployeePayrollConfigTable, initializePayrollTable } from './models/Payroll/employee_payroll_config.model.js';
import { startPayrollConfigExpiryCheck } from './controllers/Payroll/payrollConfigExpiry.controller.js';
import { initializeOfferLetterFormatTables } from './models/Employee/offerLetterFormat.model.js';
import { initializeUserSessionsTable } from './models/users/userSession.model.js';
import { startUserSessionExpiryCheck } from './controllers/users/userSession.controller.js';
import { startTaskAutoStartCheck } from './controllers/timesheet/task.controller.js';
import { initializeCompanyBankDetailsLogTable, initializeCompanyBankTable } from './models/Payroll/companyBank.model.js';
import { initializePayrollSettingsDownloadLogsTable } from './models/Payroll/payrollSettingsDownloadLog.model.js';
import googleAuthRoutes from "./GoogleChat/googleAuthRoutes.js";
import { initializeGoogleOAuthTokensTable } from "./GoogleChat/googleAuth.js";

const app = express();
const server = http.createServer(app);

socketConfig.init(server);

/* ================= GZIP COMPRESSION ================= */
app.use(
  compression({
    level: 6,
    threshold: 1024,
  })
);

/* ================= CORS ================= */
app.use(cors({
  origin: true,
  credentials: true,
  exposedHeaders: ["Content-Disposition"],
}));

/* ================= BODY PARSER ===================== */
app.use(
    express.json({
        limit: "1gb"
    })
);

app.use(
    express.urlencoded({
        extended: true,
        limit: "1gb"
    })
);

app.use(attachUserFromToken);

app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')));

app.use('/api', apiRoutes);
app.use("/auth/google", googleAuthRoutes);

/* ================= SWAGGER ================= */
app.use(
    "/config",
    express.static(path.join(process.cwd(), "src", "config"))
);

app.use(
    "/api-docs",
    swaggerUi.serve,
    swaggerUi.setup(swaggerSpec, {
        explorer: true,
        swaggerOptions: {
            persistAuthorization: true
        },
        customJs: "/config/swagger-auth-expire.js"
    })
);

app.use(notFoundHandler);
app.use(errorHandler);

const PORT = process.env.PORT || 5000;

(async () => {
    try {
        // Lookup tables used by employee migrations (work location, bond, category, education).
        await initializeLocationTable();
        await initializeBondOptionTable();
        await initializeCategoryTable();
        await initializeEducationTable();
        await initializeDepartmentStructureTable();
        await initializeDeviceConfigurationsTable();

        // ================= EMPLOYEE TABLES FIRST =================
        await initializeTableSafely(
            "personal details",
            initializePersonalDetailsTable
        );

        await initializeTableSafely(
            "master employee",
            initializeMasterEmployeeTable
        );

        await initializeTableSafely(
            "employment details",
            initializeEmploymentDetailsTable
        );

        await initializeTableSafely(
            "identification details",
            initializeIdentificationDetailsTable
        );

        await initializeTableSafely(
            "bank details",
            initializeBankDetailsTable
        );

        await initializeTableSafely(
            "educational qualifications",
            initializeEducationalQualificationsTable
        );

        await initializeTableSafely(
            "salary details",
            initializeSalaryTable
        );

        await initializeWorkExperienceTable();
        await initializeInactiveEmployeeTable();

        // ================= STATUS TABLE =================
        await initializeStatusTable();
        
        // ================= ERP DATABASE =================
        await initializeDatabase();

        // ================= CANDIDATE TABLE =================
        await initializeJobPositionTable();
        await initializeCandidateTable();
        await initializeCandidateSourceTable();
        await initializeCandidateBoardPreferenceTable();
        
        // ================= MEETING TABLE =================
        await initializeMeetingScheduleTable();
        await initializeEmployeeMeetingTable();

        // ================= FILE MANAGER =================
        await initializeTableSafely(
            'file manager',
            initializeFileManagerTable,
        );
        await initializeTableSafely(
            'file manager item folder users',
            initializeFileManagerItemFolderUsersTable,
        );
        await initializeTableSafely(
            'project file manager',
            initializeProjectFileManagerTables,
        );
        await initializeTableSafely(
            'unified file manager schema',
            initializeUnifiedFileManagerSchema,
        );
        await initializeTableSafely(
            'file manager settings',
            initializeFileManagerSettingTable,
        );
        await initializeTableSafely(
            'file manager log',
            initializeFileManagerLogTable,
        );
        await initializeTableSafely(
            'categories folder structure',
            initializeCategoriesFolderStructureTable,
        );

        // ================= SYSTEM GUIDE =================
        await initializeTableSafely(
            'system guide',
            initializeSystemGuideTables,
        );        

        await initializeTableSafely(
            'project pcb version',
            initializeProjectPcbVersionTable,
        );
        await initializeTableSafely(
            'project log',
            initializeProjectLogTable,
        );
        await initializeTableSafely(
            'pcb log',
            initializePcbLogTable,
        );
        await initializeTableSafely(
            'production log',
            initializeProductionLogTable,
        );

        // Financial year file manager folders (needs financial_years)
        await initializeTableSafely(
            'financial year file manager',
            initializeFinancialYearFileManagerTable,
        );
        await initializeTableSafely(
            'project financial year folders',
            ensureFinancialYearFolders,
        );

        // Sync physical project folders under PROJECT_FILE_MANAGER_PATH → DB + settings owner
        await initializeTableSafely(
            'project file manager disk sync',
            async () => {
                const result = await syncProjectFileManagerFromDisk('system');
                const count = result?.projects?.length || 0;
                const created = result?.structure?.created || 0;
                console.log(
                    `✅ Project FM disk sync: ${count} project(s), ${created} structure item(s) created`,
                );
            },
        );

        // ================= ATTENDANCE TABLES =================
        await initializeAttendanceSessionsTable();
        await initializeMacAddressTable();
        await initializeMqttMessagesTable();
        await initializeOpenSessionsTable();

        // Shift must exist before payroll config (shift_id FK).
        await initializeShiftTable();

        // ================= PAYROLL TABLES =================
        await initializePayrollSettingsDownloadLogsTable();
        await initializeCompanyBankTable();
        await initializeCompanyBankDetailsLogTable();
        await initializeEmployeePayrollConfigTable();
        await initializePayrollTable();
        await initializeOfferLetterFormatTables();
        await initializeUserSessionsTable();
        startUserSessionExpiryCheck();
        startPayrollConfigExpiryCheck();

        // ================= LOG TABLES =================
        await initializeAttendanceLogsTable();
        await initializeSettingLogsTable();
        await initializePayrollEditLogTable();
        await initializeUserSessionEditLogTable();
        await initializeLeaveEditLogTable();
        await initializeMeetingEditLogTable();
        await initializeCalendarEditLogTable();
        await initializeEmployeeEditLogTable();
        
        await initializeTableSafely(
            'requirement edit log',
            initializeRequirementEditLogTable,
        );
        await initializeTableSafely(
            'requirement status',
            initializeRequirementStatusTable,
        );
        await initializeTableSafely(
            'r2r temp bom images',
            () => R2rTempBomImageModel.initializeTable(),
        );
        await initializeTableSafely(
            'bom google sheets',
            initializeBomGoogleSheetTable,
        );

        // ================= OTHER TABLES =================
        await initializeDepartmentsTable();
        await initializeLeaveTable();
        await initializeLeavePriorTable();
        await initializeHolidaysTable();
        await initializeEmployeeLeavesTable();
        await TaskModel.initializeTable();
        await initializeTaskStatusHistoryTable();
        await initializeTaskStatusReasonTable();
        await initializeTaskLogTable();
        await TaskStatusModel.initializeTable();
        startTaskAutoStartCheck();

        /* ================= CONNECT MQTT ================= */
        // connectMQTT();

        await initializeDeviceVersionLogsTable();

        /* ================= MAINTENANCE ================= */
        await initializeMaintenanceTable();

        /* ================= MASTER PASSWORD ================= */
        await initializeMasterPasswordTable();   
        
        await initializeGoogleOAuthTokensTable();


        server.listen(PORT, "0.0.0.0", () => {
            console.log(`✓ Modular Server running on port ${PORT}`);
            console.log(`✓ Socket.io initialized`);
            console.log(`✓ API available at /api`);
        });

    } catch (err) {
        console.error("Failed to initialize database:", err);
        process.exit(1);
    }
})();

process.on('unhandledRejection', (err) => {
    console.error('Unhandled Rejection:', err);
});