import express from "express";
import {
  addAttendanceSession,
  deleteAttendanceSession,
  editAttendanceSession,
  getAttendanceByUsername,
  getAttendanceEntriesByUsername,
  getAttendanceSessions,
} from "../../controllers/Attendance/attendance_session.controller.js";

const attendance_session = express.Router();

/**
 * @swagger
 * /attendance-session/add-attendance-session:
 *   post:
 *     summary: Add Attendance Session
 *     tags:
 *       - Attendance
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               username:
 *                 type: string
 *               employment_id:
 *                 type: string
 *               entry_at:
 *                 type: string
 *                 format: date-time
 *               exit_at:
 *                 type: string
 *                 format: date-time
 *               status:
 *                 type: string
 *     responses:
 *       201:
 *         description: Attendance session created successfully
 *       400:
 *         description: Invalid request
 */
attendance_session.post("/add-attendance-session", addAttendanceSession);

/**
 * @swagger
 * /attendance-session/all-attendance-sessions:
 *   get:
 *     summary: Get All Attendance Sessions
 *     tags:
 *       - Attendance
 *     responses:
 *       200:
 *         description: Attendance sessions fetched successfully
 */
attendance_session.get("/all-attendance-sessions", getAttendanceSessions);

/**
 * @swagger
 * /attendance-session/attendance-by-username:
 *   get:
 *     summary: Get attendance by username and optional filters
 *     tags:
 *       - Attendance
 *     parameters:
 *       - in: query
 *         name: date
 *         schema:
 *           type: string
 *         description: Date (YYYY-MM-DD)
 *       - in: query
 *         name: username
 *         schema:
 *           type: string
 *       - in: query
 *         name: first_name
 *         schema:
 *           type: string
 *       - in: query
 *         name: last_name
 *         schema:
 *           type: string
 *       - in: query
 *         name: employment_id
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Attendance records fetched successfully
 */
attendance_session.get("/attendance-by-username", getAttendanceByUsername);

/**
 * @swagger
 * /attendance-session/username/{username}:
 *   get:
 *     summary: Get Attendance Entries By Username
 *     tags:
 *       - Attendance
 *     parameters:
 *       - in: path
 *         name: username
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Attendance entries fetched successfully
 */
attendance_session.get("/username/:username", getAttendanceEntriesByUsername);

/**
 * @swagger
 * /attendance-session/edit-attendance-session/{id}:
 *   patch:
 *     summary: Edit Attendance Session
 *     tags:
 *       - Attendance
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               entry_at:
 *                 type: string
 *                 format: date-time
 *               exit_at:
 *                 type: string
 *                 format: date-time
 *               status:
 *                 type: string
 *     responses:
 *       200:
 *         description: Attendance session updated successfully
 *       404:
 *         description: Attendance session not found
 */
attendance_session.patch("/edit-attendance-session/:id", editAttendanceSession);

/**
 * @swagger
 * /attendance-session/delete-attendance-session/{id}:
 *   delete:
 *     summary: Delete Attendance Session
 *     tags:
 *       - Attendance
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Attendance session deleted successfully
 *       404:
 *         description: Attendance session not found
 */
attendance_session.delete("/delete-attendance-session/:id", deleteAttendanceSession);

export default attendance_session;