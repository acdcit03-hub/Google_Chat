import express from 'express';
const router = express.Router();
import TimesheetController from '../../controllers/timesheet/timesheet.controller.js';
import DurationReportController from '../../controllers/timesheet/Durationreport.cotroller.js';

router.get('/',  TimesheetController.getAllTimesheets);
router.get('/stats', TimesheetController.getStats);
router.get('/summary', TimesheetController.getSummary);
router.get('/max-work', TimesheetController.getMaxWork);
router.get('/max-work-duration-process', TimesheetController.getMaxWorkDurationProcess);
router.get('/max-work-duration-users', TimesheetController.getMaxWorkDurationUsers);
router.get('/duration', DurationReportController.getDurationReport);
router.get('/report', DurationReportController.getFilteredTimesheets);
// one API per filter dropdown
router.get('/report/projects', DurationReportController.getProjectOptions);
router.get('/report/processes', DurationReportController.getProcessOptions);
router.get('/report/users', DurationReportController.getUserOptions);
router.get('/report/project-by', DurationReportController.getProjectByOptions);
router.get('/report/project-types', DurationReportController.getProjectTypeOptions);
router.get('/logs', TimesheetController.getTimesheetLogs);
router.post('/bulk',  TimesheetController.bulkCreateTimesheets);
router.get('/:id', TimesheetController.getTimesheetById);
router.post('/', TimesheetController.createTimesheet);
router.put('/:id',  TimesheetController.updateTimesheet);
router.delete('/:id',  TimesheetController.deleteTimesheet);

export default router;