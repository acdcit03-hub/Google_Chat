import express from 'express';
const router = express.Router();

import { loginEmployee } from '../controllers/Employee/employee.controller.js';
import authRoutes from './auth/reset.router.js';
import { requireAuth } from '../middleware/auth.js';
import { logoutUserSession } from '../controllers/users/userSession.controller.js';
import userSessionRoutes from './users/userSession.router.js';
import RequirementController from '../controllers/r2r/requirement.controller.js';
import UploadController from '../controllers/upload.controller.js';

import { fastApiMiddleware } from '../middleware/cache.js';
import { upload } from '../middleware/upload.js';
import categoryRoutes from './timesheet/category.routes.js';
import categoryTypeRoutes from './timesheet/categoryType.routes.js';
import departmentRoutes from './settings/department.routes.js';
import unitRoutes from './settings/unit.routes.js';
import fyRoutes from './settings/financial-year.routes.js';
import settingRoutes from './settings/setting.routes.js';
import clientRoutes from './projectsheet/client.routes.js';
import projectRoutes from './projectsheet/project.routes.js';
import requirementRoutes from './r2r/requirement.routes.js';
import requirementEditLogRoutes from './r2r/requirementEditLog.routes.js';
import pcbRoutes from './projectsheet/pcb.routes.js';
import projectPcbVersionRoutes from './projectsheet/projectPcbVersion.routes.js';
import productionRoutes from './projectsheet/production.routes.js';
import projectProcessCheckedRoutes from './projectsheet/projectProcessChecked.routes.js';
import timesheetRoutes from './timesheet/timesheet.routes.js';
import taskRoutes from './timesheet/task.routes.js';
import taskStatusRoutes from './timesheet/taskStatus.routes.js';
import issueRoutes from './r2r/issue.routes.js';
import receiveIssueResponseRoutes from './r2r/receiveIssueResponse.routes.js';
import qtyReservationRoutes from './r2r/qtyReservation.routes.js';
import r2rImageRoutes from './r2r/r2rImage.routes.js';
import bomRoutes from './r2r/bom.routes.js';
import taskListHistoryRoutes from './history/task-list-history.routes.js';
import auditLogRoutes from './history/auditLog.routes.js';
import attendance_session from './Attendance/attendance_session.router.js';
import mac_address from './Attendance/mac_address.router.js';
import open_sessions from './Attendance/open_sessions.router.js';
import bank_details from './Employee/BankDetails.router.js';
import employment_details from './Employee/EmploymentDetails.router.js';
import personal_details from './Employee/PersonalDetails.router.js';
import identification_details from './Employee/identification_details.router.js';
import educational_qualifications from './Employee/EducationalQualifications.router.js';
import salary_details from './Employee/SalaryDetails.router.js';
import bond from './settings/Bond.router.js';
import department from './settings/Deparments.router.js';
import device_configurations from './settings/DeviceConfigurations.router.js';
import location from './settings/Location.router.js';
import shift_configurations from './settings/ShiftConfigurations.router.js';
import mqtt_messages from './Attendance/mqttMessages.router.js';
import work_exprience from './Employee/WorkExperience.router.js';
import master_employee from './Employee/MasterEmployee.router.js';
import departmentStructure from './settings/DepartmentStructure.router.js';
import attendance_log from './history/attendance_logs.router.js';
import download_attendance from './download/downloadAttendance.router.js';
import holiday from './Attendance/Calendar/holiday.router.js';
import summary from './Attendance/Summary/summary.router.js';
import employee_record from './Attendance/EmployeeRecord/employee_record.router.js';
import employee_leave from './Attendance/EmployeeRecord/EmployeeLeaves.router.js';
import ImportEmployee from './Employee/importExcel.router.js';
import payroll from './Payroll/payroll.router.js';
import employeeRoutes from './Employee/employee.router.js'
import userPermissionRoutes from './users/userPagePermission.routes.js';
import maintenance from './Maintenance/Maintenance.router.js';
import category from './settings/category.router.js';
import education from './settings/education.router.js';
import MasterPassword from './auth/MasterPassword.router.js';
import download_employee_attendance from './download/MonthlyAttendance.router.js';
import setting_edit_log from './history/setting_edit_log.routes.js';
import payroll_edit_log from './history/payroll_edit_log.routes.js';
import leave_edit_log from './history/leave_edit_log.routes.js';
import user_session_edit_log from './history/user_session_edit_log.routes.js';
import meeting_edit_log from './history/meeting_edit_log.routes.js';
import updateProjectRoutes from './projectsheet/updateProject.routes.js';
import calendar_log from './history/calendar_log.router.js';
import employee_log from './history/employee_edit_log.router.js';
import device_version_log from './history/device_version_logs.router.js';
import status from './status/status.router.js';
import candidate from './Candidate/candidate.router.js';
import candidateSource from './Candidate/candidate_source.routes.js';
import job_position from './JobPosition/jobPosition.routes.js';
import meetingSchedule from './MeetingSchedule/meetingSchedule.routes.js';
import fileManagerRoutes from './filemanager/fileManager.routes.js';
import projectFileManagerRoutes from './filemanager/projectFileManager.routes.js';
import financialYearFileManagerRoutes from './filemanager/financialYearFileManager.routes.js';
import fileManagerSettingRoutes from './filemanager/fileManagerSetting.routes.js';
import categoriesFolderStructureRoutes from './filemanager/categoriesFolderStructure.routes.js';
import systemGuideRoutes from './systemGuide/systemGuide.routes.js';
import noImageRoutes from './settings/noImage.routes.js';
import leave from './settings/Leave.router.js';
import leave_prior from './settings/Leave_prior.router.js';
import globalCalendar from './Calendar/GlobalCalendar.router.js';
import employee_meeting from './MeetingSchedule/employeeMeeting.router.js';
import employee_payroll from './Payroll/employee_payroll_config.router.js';
import offerLetterFormatRoutes from './Employee/offerLetterFormat.router.js';
import payrollReport from './Payroll/payrollReport.router.js';
import companyBankDetails from './Payroll/companyBank.router.js';
import payrollSettings from './Payroll/payrollSettings.routes.js';

// Auth - Login endpoint (employee credentials)
router.post('/login', loginEmployee);
router.post('/auth/logout', requireAuth, logoutUserSession);
router.use('/auth', authRoutes);
router.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date()
    });
});

// All routes below require a valid JWT
// router.use(checkAuthorizationHeader);

router.use('/categories', categoryRoutes);
router.use('/category-types', categoryTypeRoutes);
router.use('/departments', departmentRoutes);
router.use('/units', unitRoutes);
router.use('/financial-years', fyRoutes);
router.use('/no-images', noImageRoutes);
router.use('/settings', settingRoutes);
router.use('/clients', clientRoutes);
router.use('/projects', projectRoutes);
router.use('/process-map', updateProjectRoutes);
router.use('/requirements', fastApiMiddleware, requirementRoutes);
router.use('/requirements-edit-log', requirementEditLogRoutes);
router.use('/pcbs', pcbRoutes);
router.use('/project-pcb-versions', projectPcbVersionRoutes);
router.use('/productions', productionRoutes);
router.use('/projects-process-checked', projectProcessCheckedRoutes);
router.use('/timesheets', timesheetRoutes);
router.use('/tasks', taskRoutes);
router.use('/task-statuses', taskStatusRoutes);
router.use('/issues', issueRoutes);
router.use('/notifications', receiveIssueResponseRoutes);
router.use('/qty-reservations', qtyReservationRoutes);
router.use('/images', r2rImageRoutes);
router.use('/r2r/bom', bomRoutes);
router.use('/task-list-history', taskListHistoryRoutes);
router.use('/audit-logs', auditLogRoutes);

/* ================= SETTING ================= */
router.use("/bond", bond);
router.use("/department", department);
router.use("/device-configuration", device_configurations);
router.use("/location", location);
router.use("/shift", shift_configurations);
router.use("/department-structure", departmentStructure);
router.use("/category", category);
router.use("/education", education);
router.use("/leave", leave);
router.use("/leave-prior", leave_prior);

/* ================= ATTENDANCE ================= */
router.use("/attendance-session", attendance_session);
router.use("/mac-address", mac_address);
router.use("/open-sessions", open_sessions);
router.use("/mqtt-messages", mqtt_messages);
router.use("/holiday", holiday);
router.use("/summary", summary);
router.use("/employee-record", employee_record);
router.use("/employee-leave", employee_leave);

/* ================= EMPLOYEE ================= */
router.use("/personal-details", personal_details);
router.use("/identification-details", identification_details);
router.use("/employment-details", employment_details);
router.use("/bank-details", bank_details);
router.use("/educational-qualifications", educational_qualifications);
router.use("/salary", salary_details);
router.use("/work-exprience", work_exprience);
router.use("/master-employee", master_employee);
router.use('/employees', employeeRoutes);           // send mail
router.use('/offer-letter-format', offerLetterFormatRoutes);
router.use('/users', userSessionRoutes);
router.use('/users', userPermissionRoutes);

/* ================= STATUS ================= */
router.use("/status", status);

/* ================= CALENDAR ================= */
router.use("/calendar", globalCalendar);

/* ================= FILE MANAGER ================= */
router.use('/file-manager', fileManagerRoutes);
router.use('/project-file-manager', projectFileManagerRoutes);
router.use('/financial-year-file-manager', financialYearFileManagerRoutes);
router.use('/file-manager-settings', fileManagerSettingRoutes);
router.use('/categories-folder-structure', categoriesFolderStructureRoutes);

/* ================= SYSTEM GUIDE ================= */
router.use('/system-guide', systemGuideRoutes);

/* ================= RECRUITMENT ================= */
router.use("/candidate", candidate);
router.use("/candidate-source", candidateSource);
router.use("/job-position", job_position);

/* ================= MEETINGS ================= */
router.use("/meeting-Schedule", meetingSchedule);
router.use("/employee-meeting", employee_meeting);

/* ================= PAYROLL ================= */
router.use("/payroll", payroll);
router.use("/payroll-report", payrollReport);
router.use("/employee-payroll", employee_payroll);
router.use("/company-bank-details", companyBankDetails);
router.use("/payroll-settings", payrollSettings);

/* ================= DOWNLOAD ================= */
router.use("/download", download_attendance);
router.use("/compare-attendance", download_employee_attendance);        // compare attendance and employee worksheet

/* ================= IMPORT EMPLOYEE DETAILS ================= */
router.use("/import", ImportEmployee);

/* ================= LOG ================= */
router.use("/attendance-logs", attendance_log);
router.use("/setting-logs", setting_edit_log);  //  edit setting log
router.use("/payroll-logs", payroll_edit_log);
router.use("/leave-logs", leave_edit_log);
router.use("/meeting-logs", meeting_edit_log);
router.use("/user-session-logs", user_session_edit_log);
router.use("/calendar-logs", calendar_log);  //  edit calendar log
router.use("/employee-logs", employee_log);  //  edit employee log
router.use("/device-version-logs", device_version_log);  //  edit device version log

/* ================= MAINTENANCE ================= */
router.use("/maintenance", maintenance);

/* ================= MASTER PASSWORD ================= */
router.use("/master-password", MasterPassword);

// Health check


// Upload
router.post(
    '/upload-image',
    upload.single('image'),
    UploadController.uploadImage
);

// Next serial (projects: GET /api/projects/next-serial via project.routes.js)
router.get(
    '/next-serial-number',
    RequirementController.getNextSerialNumber
);

export default router;