# ACDC ERP — Backend API Server

Node.js + Express REST API backend for the ACDC ERP system. Handles all business logic, database operations, file uploads, and real-time Socket.IO events.

---

## 📁 File & Folder Structure

```
mainbackend/
│
├── server.js                  # Express app entry point & Socket.IO setup
├── database.js                # PostgreSQL connection pools (DB1 + DB2) & table init
├── .env                       # Environment variables (not committed)
├── .env.example               # Template for environment variables
│
└── src/
    ├── config/
    │   ├── db.js              # Exports `pool` and `pool2`
    │   ├── socket.js          # Socket.IO `broadcast()` helper
    │   └── multer.js          # Multer in-memory file upload config
    │
    ├── controllers/           # Handle HTTP requests & send responses
    │   ├── user.controller.js
    │   ├── client.controller.js
    │   ├── project.controller.js
    │   ├── timesheet.controller.js
    │   ├── requirement.controller.js
    │   ├── pcb.controller.js
    │   ├── production.controller.js
    │   ├── issue.controller.js
    │   ├── category.controller.js
    │   ├── department.controller.js
    │   ├── unit.controller.js
    │   ├── setting.controller.js
    │   └── financial-year.controller.js
    │
    ├── models/                # Raw SQL queries (via pg driver)
    │   └── *.model.js
    │
    ├── routes/                # Express routers
    │   ├── index.js           # Root router — mounts all sub-routes under /api
    │   └── *.routes.js
    │
    └── utils/
        └── project.utils.js   # Time calc, sweep-line, formatting helpers
```

---

## ⚙️ Environment Variables (`.env`)

`POST /auth/google/setup-project` starts a user OAuth flow using
`GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. On first use, it opens Google
sign-in in the backend computer's browser. After consent, the callback searches
first for `GOOGLE_CLOUD_PROJECT_ID` in `.env`, then for the saved database
setting. It creates a project with display name `ERp-Google-Chat`, trying
project ID `google-chat` first. If that globally unique ID is already in use,
it tries a unique `google-chat-<suffix>` ID. The created project ID is saved in
the `settings` table as `google_cloud_project_id` and in `.env`, and subsequent
setup calls fetch and reuse that project. It then enables the Google Chat API.
The signed-in Google user needs permission to create projects and enable APIs.

Set `GOOGLE_REDIRECT_URI=http://localhost:9000/auth/google/callback` and add
that exact URL to the OAuth client's authorized redirect URIs in Google Cloud
Console. The currently configured OAuth Playground callback will not work for
this backend callback flow. The `GOOGLE_TOKEN_ENCRYPTION_KEY` must also be set
to a 64-character hexadecimal key; the refresh token is stored encrypted in
PostgreSQL.

The OAuth flow does not use `GOOGLE_SERVICE_ACCOUNT_JSON`. The optional
service-account-based setup remains available at
`POST /auth/google/setup-project/automated` if a valid service-account key is
configured.

An OAuth client JSON (with a top-level `web` or `installed` field) is not a
service-account key and should not be used with the optional automated
service-account endpoint.

The browser-based manual project creation page is available separately at
`POST /auth/google/setup-project/create-page`. On Windows, the APIs & Services
page for a project can be opened at `POST /auth/google/setup-project/open-apis`
with `{"projectId":"your-project-id"}`. Browser-opening endpoints accept local
requests only.

```env


# ── Payroll field encryption ─────────────────
# Generate once with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# Keep the same key in every environment that reads this database.
# PAYROLL_ENCRYPTION_KEY=<paste the generated 64-character hex key here>

# ── Cloudinary ──────────────────────────────
CLOUDINARY_CLOUD_NAME=your_cloud_name
CLOUDINARY_API_KEY=your_api_key
CLOUDINARY_API_SECRET=your_api_secret
```

---

## 🚀 Running the Server

```bash
npm install     # Install dependencies
npm run dev     # Development with hot-reload (nodemon)
npm start       # Production
```

> On first start, `database.js` **auto-creates all tables** and seeds default admin, categories, units, and settings.

---



## 📋 HTTP Status Code Reference

| Code | Meaning |
|------|---------|
| `200` | OK — request succeeded |
| `201` | Created — new resource created |
| `400` | Bad Request — validation or duplicate error |
| `401` | Unauthorized — invalid credentials or inactive account |
| `404` | Not Found — resource does not exist |
| `500` | Internal Server Error — unexpected failure |

---

---

# 🔗 Full API Reference

---

## 👤 Users — `/api/users`

Manages all Employee accounts in the ACDC ERP system. Supports full CRUD, role assignment, department linking, and permission arrays. Passwords are **bcrypt-hashed** before storage. A random avatar colour is assigned on creation. The default admin account (`admin` / `admin@123`) is seeded automatically on first startup.

---

### `GET /api/users` — Get All Users

> Returns the complete list of all registered users. Used by the User Management page to populate the user table. Passwords are **never** returned in any response.

**✅ Success `200`**
```json
{
  "success": true,
  "users": [
    {
      "id": 1,
      "first_name": "Admin",
      "last_name": "User",
      "username": "admin",
      "email": "admin@admin.com",
      "department": "IT",
      "access": 1,
      "status": 1,
      "permissions": ["Dashboard", "R2R", "Timesheet"],
      "avatar_color": "#1a434c",
      "created_at": "2026-01-01T00:00:00.000Z"
    }
  ]
}
```

**❌ Failed `500`**
```json
{ "success": false, "message": "Failed to fetch users" }
```

---

### `GET /api/users/:id` — Get User by ID

> Fetches a single user record by their database `id`. Useful when loading a profile edit form or resolving a user from a session token.

**✅ Success `200`**
```json
{
  "success": true,
  "user": {
    "id": 3,
    "first_name": "John",
    "last_name": "Doe",
    "username": "john.doe",
    "email": "john@acdc.com",
    "department": "Design",
    "access": 0,
    "status": 1,
    "permissions": ["Timesheet", "Dashboard"],
    "avatar_color": "#234a6a"
  }
}
```

**❌ Not Found `404`**
```json
{ "success": false, "message": "User not found" }
```

---

### `POST /api/users` — Create User

> Creates a new Employee account. The server checks for duplicate `username` / `email` and hashes the password **before** writing to DB. A random avatar colour from a curated palette is assigned automatically. `access: 1` grants admin rights; `access: 0` is a regular user. The `permissions` array controls which pages the user can access in the frontend.

**Request Body:**
```json
{
  "firstName": "John",
  "middleName": "",
  "lastName": "Doe",
  "username": "john.doe",
  "password": "secret123",
  "email_id": "john@acdc.com",
  "department": "Design",
  "access": 0,
  "status": 1,
  "permissions": ["Timesheet", "Dashboard"]
}
```

**✅ Success `201`**
```json
{
  "success": true,
  "message": "User created successfully",
  "user": {
    "id": 5,
    "username": "john.doe",
    "email": "john@acdc.com",
    "access": 0,
    "avatar_color": "#4a236a"
  }
}
```

**❌ Validation Failed `400`**
```json
{ "success": false, "message": "Username, password, and email are required" }
```

**❌ Duplicate `400`**
```json
{ "success": false, "message": "Username or email already exists" }
```

**❌ Server Error `500`**
```json
{ "success": false, "message": "Failed to create user" }
```

---

### `PUT /api/users/:id` — Update User

> Updates any combination of user fields. If a new `password` is provided it is re-hashed before saving; if left blank the existing password is kept unchanged. Duplicate username/email checks exclude the current user so self-updates don't incorrectly fail.

**✅ Success `200`**
```json
{
  "success": true,
  "message": "User updated successfully",
  "user": { "id": 5, "username": "john.doe", "department": "IT" }
}
```

**❌ Not Found `404`**
```json
{ "success": false, "message": "User not found" }
```

**❌ Duplicate `400`**
```json
{ "success": false, "message": "Username or email already exists" }
```

---

### `DELETE /api/users/:id` — Delete User

> Permanently removes the user record. Existing timesheet entries created by this user are **not** deleted — they retain the `user_id` for historical reporting. Use with caution in production.

**✅ Success `200`**
```json
{ "success": true, "message": "User deleted successfully" }
```

**❌ Not Found `404`**
```json
{ "success": false, "message": "User not found" }
```

---

---

## 🏢 Clients — `/api/clients`

Manages client records. Each client has a unique `client_code` used throughout projectCode. Logos are uploaded to **Cloudinary** and the URL is stored in the database. A bulk-import endpoint allows pasting an array of clients in a single call.

---

### `GET /api/clients` — Get All Clients

> Returns every client in the database including their logo URL (Cloudinary CDN link). Used by the Clients list page and the project-creation client selector dropdown.

**✅ Success `200`**
```json
{
  "success": true,
  "clients": [
    {
      "id": 1,
      "company_name": "ABC Technologies",
      "client_code": "ABC",
      "client_firstname": "Raj",
      "client_lastname": "Kumar",
      "client_mobile_no": "9876543210",
      "email_id": "raj@abc.com",
      "location": "Mumbai",
      "gst_code": "27AABCU9603R1ZX",
      "client_logo": "https://res.cloudinary.com/xxx/image/upload/clients/abc_logo.jpg",
      "created_at": "2026-01-15T10:00:00.000Z"
    }
  ]
}
```

**❌ Failed `500`**
```json
{ "success": false, "message": "Failed to fetch clients" }
```

---

### `GET /api/clients/:id` — Get Client by ID

> Fetches a single client by database `id`. Useful when pre-filling a client edit form.

**✅ Success `200`**
```json
{
  "success": true,
  "client": { "id": 1, "company_name": "ABC Technologies", "client_code": "ABC" }
}
```

**❌ Not Found `404`**
```json
{ "success": false, "message": "Client not found" }
```

---

### `POST /api/clients` — Create Client

> Inserts a new client record. The `client_code` must be unique — it is used as the foreign key in the `PROJECT` table. Upload the logo separately via `upload-logo` and then include the returned URL in the create/update body.

**✅ Success `201`**
```json
{
  "success": true,
  "message": "Client created successfully",
  "client": { "id": 8, "company_name": "XYZ Corp", "client_code": "XYZ" }
}
```

---

### `POST /api/clients/upload-logo` — Upload Logo

> Uploads a client logo image to Cloudinary and returns the public CDN URL. Call this **before** creating or updating a client, then pass the returned `imageUrl` in the client body as `client_logo`. Accepts JPEG, PNG, GIF, and WebP.

Form field: `logo` (image file)

**✅ Success `200`**
```json
{
  "success": true,
  "imageUrl": "https://res.cloudinary.com/dkcqsmdkl/image/upload/clients/xyz_logo.jpg"
}
```

**❌ No File `400`**
```json
{ "success": false, "message": "No file provided" }
```

---

### `DELETE /api/clients/:id` — Delete Client

> Permanently removes a client record. Projects linked to this client via `client_code` are **not** automatically deleted — they will retain the code for historical reference. Ensure no active projects exist for the client before deleting.

**✅ Success `200`**
```json
{ "success": true, "message": "Client deleted successfully" }
```

**❌ Not Found `404`**
```json
{ "success": false, "message": "Client not found" }
```

---

---

## 📁 Projects — `/api/projects`

The central module of the ERP. Tracks the full lifecycle of every project — from planning through to completion. Each record stores assigned users, processes, priority, status, target hours, and running work/net-time counters. Work hours are recalculated in the background after every timesheet stop event using the **sweep-line algorithm**. Photos and documents are stored on **Cloudinary** per project folder.

---

### `GET /api/projects` — Get All Projects (Paginated)

**Query Params:**

| Param | Example | Description |
|-------|---------|-------------|
| `page` | `1` | Page number |
| `limit` | `10` | Records per page |
| `status` | `In Progress` | Filter by status |
| `all` | `true` | Disable pagination — return all |
| `projectCode` | `001MABC001001` | Filter by project code |
| `category` | `M` | Filter by category letter |
| `user_id` | `3` | Filter by assigned user ID |

> Returns a paginated list of projects with live `work_hour` and `net_time` values already calculated. Pass `all=true` to skip pagination and retrieve every project (use sparingly on large datasets). Sorted by `created_at` descending by default.

**✅ Success `200`**
```json
{
  "success": true,
  "projects": [
    {
      "id": 12,
      "project_name": "PROJECT ALPHA",
      "project_code": "001MABC001001",
      "client_code": "ABC",
      "status": "In Progress",
      "work_hour": "45h 30m",
      "net_time": "40h 15m",
      "priority": "1",
    
      "assigned_user_ids": [1, 2],

      "created_at": "2026-02-01T08:00:00.000Z"
    }
  ],
  "pagination": {
    "total": 85,
    "limit": 10,
    "offset": 0,
    "page": 1,
    "totalPages": 9,
    "hasNextPage": true,
    "hasPrevPage": false
  }
}
```

**❌ Server Error `500`**
```json
{ "success": false, "message": "Internal server error" }
```

---

### `GET /api/projects/:id` — Get Project by ID

> Fetches a single project's full detail by database `id`. Returns all fields including `work_hour`, `net_time`, `target_hour`, and `per_day_hour` for progress calculations on the project detail page.

**✅ Success `200`**
```json
{
  "success": true,
  "project": {
    "id": 12,
    "project_name": "PROJECT ALPHA",
    "project_code": "001MABC001001",
    "status": "In Progress",
    "work_hour": "45h 30m",
    "net_time": "40h 15m",
    "target_hour": 120,
    "per_day_hour": 8
  }
}
```

**❌ Not Found `404`**
```json
{ "success": false, "message": "Project not found" }
```

---

### `GET /api/projects/code/:code` — Get Project by Code

> Looks up a project using its human-readable `project_code` (e.g. `001MABC001001`). Used by the timesheet entry form to validate that the entered project code exists before starting a timer.

**✅ Success `200`**
```json
{
  "success": true,
  "project": { "id": 12, "project_code": "001MABC001001", "project_name": "PROJECT ALPHA" }
}
```

**❌ Not Found `404`**
```json
{ "success": false, "message": "Project not found" }
```

---

### `POST /api/projects` — Create Project

> Creates a new project. The `project_code` must be unique — the server rejects duplicates with a `400`. Assigned user IDs are stored as a JSONB array. Process IDs are also stored as JSONB for flexible multi-process assignment. Initial `work_hour` and `net_time` are both `"0h"` until timesheet entries are logged.

**Request Body:**
```json
{
  "project_name": "PROJECT BETA",
  "project_code": "002MABC002001",
  "client_code": "ABC",

  "assigned_user_ids": [2, 3],

  "status": "In Planning",
  "priority": "2",
  "target_hour": 80,
  "per_day_hour": 8,


  "created_by": "admin"
}
```

**✅ Success `201`**
```json
{
  "success": true,
  "message": "Project created successfully",
  "project": {
    "id": 13,
    "project_code": "002MABC002001",
    "project_name": "PROJECT BETA",
    "status": "In Planning",
    "work_hour": "0h",
    "net_time": "0h"
  }
}
```

**❌ Missing Fields `400`**
```json
{ "success": false, "message": "Project name is required" }
```

**❌ Duplicate Code `400`**
```json
{ "success": false, "message": "Project code \"002MABC002001\" already exists" }
```

---

### `POST /api/projects/upload-photo` — Upload Photo / Document

> Uploads a project photo or document to Cloudinary under the folder `projects/{project_code}/`. Supports images (JPEG, PNG, GIF, WebP) and documents (PDF, DOC, DOCX, XLS, XLSX). Returns both the file URL and a `fileType` field so the frontend can render a preview or a download link accordingly.

Form fields: `photo` (file), `project_code` (string)

**✅ Success `200`**
```json
{
  "success": true,
  "imageUrl": "https://res.cloudinary.com/.../projects/001MABC001001/photo_1709999999_design.jpg",
  "url": "https://res.cloudinary.com/.../...",
  "publicId": "projects/001MABC001001/photo_xxx",
  "folder": "projects/001MABC001001",
  "fileType": "image"
}
```

**❌ No File `400`**
```json
{ "success": false, "message": "No file provided" }
```

**❌ Invalid Type `400`**
```json
{
  "success": false,
  "message": "Invalid file type. Only images (JPEG, PNG, GIF, WebP) and documents (PDF, DOC, DOCX, XLS, XLSX) are allowed."
}
```

---

### `PUT /api/projects/:id` — Update Project

> Partially updates a project — only the fields present in the request body are changed. After certain status changes (e.g. to `Completed`) the server logs a record to `HS_Status` for audit tracking. Work hours are recalculated server-side after the update.

**✅ Success `200`**
```json
{
  "success": true,
  "message": "Project updated successfully",
  "project": {
    "id": 12,
    "status": "In Progress",
    "work_hour": "50h 15m",
    "net_time": "44h 30m"
  }
}
```

**❌ No Fields `400`**
```json
{ "success": false, "message": "No fields to update" }
```

**❌ Not Found `404`**
```json
{ "success": false, "message": "Project not found" }
```

---

### `DELETE /api/projects/:id` — Delete Project

> Permanently removes the project record. Related timesheet entries are **not** cascade-deleted — they will remain in the DB with their `project_code` intact for historical reporting. Cloudinary assets are also **not** auto-deleted; clean them up manually if needed.

**✅ Success `200`**
```json
{ "success": true, "message": "Project deleted successfully" }
```

**❌ Not Found `404`**
```json
{ "success": false, "message": "Project not found" }
```

---

---

## ⏱️ Timesheets — `/api/timesheets`

Records every work session (start → stop) against a project. The `duration` column is **auto-calculated** from `start_time` and `stop_time` on write. Server-side pagination (default 10 rows, configurable up to any reasonable limit) prevents memory exhaustion with thousands of entries. A dedicated `/summary` endpoint aggregates totals across all matching rows without transferring all rows to the client.

---

### `GET /api/timesheets` — Get Timesheets (Paginated)

**Query Params:**

| Param | Example | Description |
|-------|---------|-------------|
| `page` | `1` | Page number (default: `1`) |
| `limit` | `100` | Records per page (default: `10`) |
| `user_id` | `3` | Filter by user ID |
| `project_code` | `001MABC001001` | Filter by project code |
| `date` | `2026-03-07` | Filter by specific date |
| `today` | `true` | Only today's entries |
| `type` | `Software` | Filter by project type |
| `project` | `ALPHA` | Search project name/code |
| `startTime` | `09:00` | Filter by start time |
| `stopTime` | `17:00` | Filter by stop time |
| `projectBy` | `John Doe` | Filter by person name |
| `notes` | `module` | Search in notes |
| `user` | `john` | Search by username/name |

> Returns one page of timesheet rows matching all supplied filters. The `pagination` object tells the frontend how many total pages exist so it can render page controls without fetching all data upfront. Combine `project_code` + `date` for the most targeted queries.

**✅ Success `200`**
```json
{
  "success": true,
  "timesheets": [
    {
      "id": 1001,
      "project_code": "001MABC001001",
      "project_type": "Software",
      "start_time": "09:00:00",
      "stop_time": "17:30:00",
      "duration": "08:30:00",
      "project_by": "John Doe",
      "user_id": 3,
      "notes": "Completed module A",
      "date": "2026-03-07",
      "created_at": "2026-03-07T09:00:00.000Z"
    }
  ],
  "pagination": {
    "currentPage": 1,
    "totalPages": 70,
    "totalCount": 6999,
    "limit": 100,
    "hasNextPage": true,
    "hasPrevPage": false
  }
}
```

**❌ Server Error `500`**
```json
{ "success": false, "message": "Internal server error" }
```

---

### `GET /api/timesheets/summary` — Get Duration Summary

> Computes aggregate totals across **all** matching timesheet entries (same filters as GET, but no pagination). Returns `totalDuration` (raw sum of all durations) and `netTime` (overlaps removed via the sweep-line algorithm). Use this on the Report page header to show accurate totals without loading every row into the browser.

Returns total duration and net time for **all** matching records (no pagination).

**✅ Success `200`**
```json
{
  "success": true,
  "summary": {
    "totalDuration": "1245:30:00",
    "netTime": "1100:15:00",
    "totalEntries": 6999
  }
}
```

> `netTime` is calculated via O(n log n) **sweep-line algorithm** — accurately removes overlapping work times.

**❌ Server Error `500`**
```json
{ "success": false, "message": "Internal server error" }
```

---

### `GET /api/timesheets/:id` — Get Single Timesheet

> Fetches one timesheet entry by its database `id`. Used when an employee wants to review or edit a specific work log entry.

**✅ Success `200`**
```json
{
  "success": true,
  "timesheet": {
    "id": 1001,
    "project_code": "001MABC001001",
    "start_time": "09:00:00",
    "stop_time": "17:30:00",
    "duration": "08:30:00",
    "date": "2026-03-07"
  }
}
```

**❌ Not Found `404`**
```json
{ "success": false, "message": "Timesheet not found" }
```

---

### `POST /api/timesheets` — Create Timesheet Entry

> Logs a new work session. The server auto-calculates `duration` from `start_time` and `stop_time` so the client does not need to send it. After creation, the parent project's `work_hour` and `net_time` are recalculated asynchronously in the background so the response is fast.

**Request Body:**
```json
{
  "project_code": "001MABC001001",
  "project_type": "Software",
  "category_letter": "M",
  "process_name": "Assembly",
  "process_id": 3,
  "start_time": "09:00:00",
  "stop_time": "17:30:00",
  "project_by": "John Doe",
  "user_id": 3,
  "notes": "Completed module A",
  "date": "2026-03-07"
}
```

> `duration` is **auto-calculated** from `start_time` + `stop_time`. No need to send it.

**✅ Success `201`**
```json
{
  "success": true,
  "message": "Timesheet created successfully",
  "timesheet": {
    "id": 1002,
    "project_code": "001MABC001001",
    "start_time": "09:00:00",
    "stop_time": "17:30:00",
    "duration": "08:30:00",
    "date": "2026-03-07"
  }
}
```

**❌ Server Error `500`**
```json
{ "success": false, "message": "Failed to create timesheet" }
```

---

### `POST /api/timesheets/bulk` — Bulk Import Timesheets

> Accepts an array of timesheet entries and inserts them all in a single transaction. Useful when importing historical data from Excel/CSV. Duration is auto-calculated for each entry. If any entry fails validation the error is reported per-entry and the rest are still attempted (partial success is possible). Expected headers for CSV import: `PROJECT NAME`, `START TIME`, `STOP TIME`, `WORK HOUR AS MINUTES`, `PROJECT BY`.

**Request Body:**
```json
{
  "entries": [
    {
      "project_code": "001MABC001001",
      "project_type": "Software",
      "start_time": "09:00:00",
      "stop_time": "12:00:00",
      "project_by": "John Doe",
      "user_id": 3,
      "date": "2026-03-06"
    },
    {
      "project_code": "001MABC001001",
      "project_type": "Hardware",
      "start_time": "13:00:00",
      "stop_time": "17:00:00",
      "project_by": "Jane Smith",
      "user_id": 4,
      "date": "2026-03-06"
    }
  ]
}
```

**✅ Success `201`**
```json
{
  "success": true,
  "message": "Successfully imported 2 entries",
  "results": [ { "id": 1003 }, { "id": 1004 } ]
}
```

**❌ Invalid Payload `400`**
```json
{ "success": false, "message": "Entries must be an array" }
```

**❌ Server Error `500`**
```json
{ "success": false, "message": "Failed to bulk import timesheets" }
```

---

### `PUT /api/timesheets/:id` — Update Timesheet

> Updates a timesheet entry. If `start_time` or `stop_time` are changed, `duration` is **recalculated** automatically. After the update, the parent project's running totals are also recalculated in the background.

**✅ Success `200`**
```json
{
  "success": true,
  "message": "Timesheet updated successfully",
  "timesheet": {
    "id": 1001,
    "stop_time": "18:00:00",
    "duration": "09:00:00"
  }
}
```

**❌ Not Found `404`**
```json
{ "success": false, "message": "Timesheet not found" }
```

---

### `DELETE /api/timesheets/:id` — Delete Timesheet

> Permanently removes a timesheet entry. The parent project's `work_hour` and `net_time` are recalculated automatically after deletion so totals remain accurate.

**✅ Success `200`**
```json
{ "success": true, "message": "Timesheet deleted successfully" }
```

**❌ Not Found `404`**
```json
{ "success": false, "message": "Timesheet not found" }
```

---

---

## 📦 Requirements (R2R) — `/api/requirements`

Handles the **Request-to-Receive (R2R)** purchase request workflow. Each requirement tracks a component or material needed for a project, from initial request through ordering, delivery, and storage. Serial numbers follow the format `RFQ-YYMM-NNN` and are unique per month. Data lives in a **separate PostgreSQL database** (`requirement` / DB2).

**Status lifecycle:**
```
Request Review → Review Done → Order Placed → In Store → Terminated
```

---

### `GET /api/requirements` — Get All Requirements

**Query Params:** `status` (e.g. `Request Review`, `In Store`)

> Returns all purchase requirements, optionally filtered by workflow status. Used by the R2R list page to display open or completed requests.

**✅ Success `200`**
```json
{
  "success": true,
  "requirements": [
    {
      "sr.no": 42,
      "serial_number": "RFQ-2603-001",
      "product_name": "Resistor 10k",
      "quantity": 500,
      "unit": "PCS",
      "status": "Request Review",
      "order_status": "Normal",
      "project_name": "PROJECT ALPHA",
      "require_person_name": "John Doe",
      "target_receive_date": "15-04-2026",
      "created_at": "2026-03-07T10:00:00.000Z"
    }
  ]
}
```

**❌ Failed `500`**
```json
{ "success": false, "message": "Failed to fetch requirements" }
```

---

### `GET /api/requirements/stats` — Get Requirement Stats

> Returns statistics on requirements grouped by status. Used for dashboard widgets.

**✅ Success `200`**
```json
{
  "success": true,
  "stats": {
    "total": 988,
    "urgent": 39,
    "terminateRequested": 0,
    "requestReview": 41,
    "inStore": 11,
    "purchase": 14,
    "receiveDone": 846,
    "orderDone": 20,
    "issue": 1,
    "terminated": 55,
    "requestReviewIssue": 0,
    "requestReviewUrgent": 14,
    "inStoreUrgent": 11,
    "purchaseUrgent": 13,
    "receiveIssue": 2
  }
}
```

---

### `GET /api/requirements/filter-options/persons` — Get Person Filter Options

> Returns distinct values for `require_person_name` to be used in frontend filter dropdowns.

**✅ Success `200`**
```json
{
  "success": true,
  "persons": ["John Doe", "Jane Smith"]
}
```

---

### `GET /api/requirements/next-serial` — Get Next Serial Number

> Generates the next available serial number for the current year-month. The counter resets every month. Call this **before** rendering the create-requirement form so the serial field is pre-filled. The `prefix` defaults to the `serial_prefix` setting value (`RFQ`).

**Query Params:** `prefix` (default: `RFQ`)

**✅ Success `200`**
```json
{
  "success": true,
  "serialNumber": "RFQ-2627-616",
  "serial_number": "RFQ-2627-616"
}
```

> Format: `{prefix}-{YYMM}-{3-digit counter}`.

**❌ Failed `500`**
```json
{ "success": false, "message": "Failed to generate serial number" }
```

---

### `POST /api/requirements/bulk-verify` — Bulk Verify Requirements

> Allows bulk updates/verification of multiple requirement rows at once.

**Request Body:**
```json
{
  "ids": [42, 43],
  "status": "Review Done"
}
```

**✅ Success `200`**
```json
{ "success": true, "message": "Requirements verified successfully" }
```

---

### `POST /api/requirements/bom-batch-notify` — Notify BOM Batch Created

> Triggers a notification that a new BOM batch has been created.

**✅ Success `200`**
```json
{ "success": true, "message": "Notification sent" }
```

---

### Temp Requirements & Drafts

These endpoints handle autosaving drafts and associated temp images before final requirement submission.

- `POST /api/requirements/temp` — Create Temp Requirement (Draft)
- `PUT /api/requirements/temp/:id` — Update Temp Requirement
- `GET /api/requirements/temp` — List Temp Requirements
- `GET /api/requirements/temp/:temp_id` — Get Temp Requirement by UUID
- `DELETE /api/requirements/temp/:id` — Delete Temp Requirement

### Temp BOM Images

These endpoints handle uploading and associating BOM images with a draft requirement.

- `POST /api/requirements/temp-image` — Create Temp BOM Image
- `PUT /api/requirements/temp-image/:id` — Update Temp BOM Image
- `POST /api/requirements/temp-image/transfer` — Transfer Temp BOM Image to final requirement
- `GET /api/requirements/temp-image/:serial_number` — Get Temp BOM Images for a specific serial

---

### `GET /api/requirements/:id` — Get by ID

> Fetches a single requirement by its auto-incremented primary key (`sr.no`). Used when opening a detail/edit modal for a specific purchase request.

**✅ Success `200`**
```json
{
  "success": true,
  "requirement": { "sr.no": 42, "product_name": "Resistor 10k", "quantity": 500 }
}
```

**❌ Not Found `404`**
```json
{ "success": false, "message": "Requirement not found" }
```

---

### `POST /api/requirements` — Create Requirement

> Creates a new purchase request. The `serial_number` must be unique — use the `/next-serial` endpoint to pre-generate one. `status` should start as `Request Review`. An issue notification is typically also created (via `/api/issues`) to alert the reviewer.

**Request Body:**
```json
{
  "serial_number": "RFQ-2603-005",
  "product_name": "Capacitor 100uF",
  "quantity": 200,
  "unit": "PCS",
  "package": "1206",
  "project_name": "PROJECT ALPHA",
  "require_person_name": "John Doe",
  "requirement_type": "Component",
  "status": "Request Review",
  "target_receive_date": "20-04-2026"
}
```

**✅ Success `201`**
```json
{
  "success": true,
  "message": "Requirement created successfully",
  "requirement": { "sr.no": 43, "serial_number": "RFQ-2603-005", "product_name": "Capacitor 100uF" }
}
```

**❌ Duplicate Serial `400`**
```json
{ "success": false, "message": "Serial number already exists" }
```

**❌ Server Error `500`**
```json
{ "success": false, "message": "Failed to create requirement" }
```

---

### `PUT /api/requirements/:id` — Update Requirement

> Advances the requirement through the workflow. Any field can be updated — typically `status` and `order_status` are changed as the request moves through review, ordering, and receiving stages. When status changes to `In Store` the frontend also triggers a notification issue for the store team.

**✅ Success `200`**
```json
{
  "success": true,
  "message": "Requirement updated successfully",
  "requirement": { "sr.no": 42, "status": "In Store", "order_status": "Normal" }
}
```

**❌ Not Found `404`**
```json
{ "success": false, "message": "Requirement not found" }
```

---

### `DELETE /api/requirements/:id` — Delete Requirement

> Permanently removes a requirement. Any linked issue notifications in the `ISSUE` table are **not** automatically deleted — delete them separately via `/api/issues/:id` if needed.

**✅ Success `200`**
```json
{ "success": true, "message": "Requirement deleted successfully" }
```

**❌ Not Found `404`**
```json
{ "success": false, "message": "Requirement not found" }
```

---

### `POST /api/requirements/:id/issue` — Report Issue

> Marks a requirement as having an issue (e.g. damaged during shipping).

**✅ Success `200`**
```json
{ "success": true, "message": "Issue reported successfully" }
```

---

### `POST /api/requirements/:id/terminate` — Terminate Requirement

> Requests to cancel/terminate the requirement. Moves status to `Terminate Requested`.

**✅ Success `200`**
```json
{ "success": true, "message": "Requirement termination requested" }
```

---

### `PUT /api/requirements/:id/confirm-terminate` — Confirm Terminate

> Confirms the termination request, moving status to `Terminated`.

**✅ Success `200`**
```json
{ "success": true, "message": "Requirement terminated successfully" }
}
```

---

---

## 🖥️ PCB — `/api/pcb`

Tracks PCB (Printed Circuit Board) design records linked to projects. Each PCB entry stores a unique PCB code, a link to the design file (e.g. Google Drive or EDA tool), an optional photo uploaded to **Cloudinary**, and a reference to its parent project. Serial numbers are managed manually but the last serial can be fetched to auto-increment in the frontend.

---

### `GET /api/pcbs` — Get All PCB Records

**Query Params:**

| Param | Example | Description |
|-------|---------|-------------|
| `page` | `1` | Page number (default: `1`) |
| `limit` | `10` | Records per page (default: `10`) |
| `all` | `true` | Disable pagination — return all |
| `id` | `5` | Filter by internal PCB ID |
| `project_code` | `001MABC001001` | Filter by project code |
| `project_id` | `12` | Filter by internal project ID |
| `pcb_code` | `PCB-001` | Filter by PCB code |
| `project_name` | `ALPHA` | Search in project name |
| `financialYear` | `25-26` | Filter by financial year |

**✅ Success `200`**
```json
{
  "success": true,
  "pcbs": [
    {
      "id": 5,
      "pcb_code": "PCB-001",
      "project_code": "001MABC001001",
      "project_name": "PROJECT ALPHA",
      "link": "https://drive.google.com/...",
      "pcb_photo": "https://res.cloudinary.com/.../pcb.jpg",
      "created_by": "admin",
      "created_at": "2026-02-10T07:00:00.000Z"
    }
  ]
}
```

---

### `GET /api/pcb/last-serial` — Get Last PCB Serial

> Returns the most recently created PCB code so the frontend can suggest the next one (e.g. `PCB-007` → suggest `PCB-008`). This is a convenience helper — the server does not auto-increment PCB codes.

**✅ Success `200`**
```json
{ "success": true, "lastSerial": "PCB-007" }
```

---

### `POST /api/pcb` — Create PCB

> Registers a new PCB design entry. The `pcb_code` must be unique. Upload the board photo using `upload-photo` first and include the returned URL in the body.

**Request Body:**
```json
{
  "pcb_code": "PCB-008",
  "project_code": "001MABC001001",
  "project_name": "PROJECT ALPHA",
  "link": "https://drive.google.com/...",
  "created_by": "admin"
}
```

**✅ Success `201`**
```json
{
  "success": true,
  "message": "PCB created successfully",
  "pcb": { "id": 8, "pcb_code": "PCB-008", "project_code": "001MABC001001" }
}
```

**❌ Duplicate `400`**
```json
{ "success": false, "message": "PCB code already exists" }
```

---

### `POST /api/pcb/upload-photo` — Upload PCB Photo

> Uploads an image of the PCB board/schematic to Cloudinary under `pcb/{pcb_code}/`. Returns the CDN URL to store with the PCB record.

Form field: `photo` (image file)

**✅ Success `200`**
```json
{
  "success": true,
  "imageUrl": "https://res.cloudinary.com/.../pcb/PCB-008/photo.jpg"
}
```

---

### `PUT /api/pcb/:id` — Update PCB

> Updates a PCB record's fields (design link, photo URL, project association). Only supplied fields are changed.

**✅ Success `200`**
```json
{ "success": true, "message": "PCB updated successfully", "pcb": { "id": 8 } }
```

**❌ Not Found `404`**
```json
{ "success": false, "message": "PCB not found" }
```

---

### `DELETE /api/pcb/:id` — Delete PCB

> Removes a PCB record. Production batches that reference this `pcb_code` are **not** automatically updated — verify no active production batches depend on it before deleting.

**✅ Success `200`**
```json
{ "success": true, "message": "PCB deleted successfully" }
```

---

---

## 🏭 Production — `/api/productions`

Tracks manufacturing batch runs tied to a PCB design and project. Each production record covers a lot (batch) of PCBs being assembled — from scheduling through completion. File attachments (BOM, Gerber files, stencil specs) are uploaded to Cloudinary. Supports full pagination and filtering for efficient list rendering.

**Status values:** `Scheduled` → `In Progress` → `Completed` | `On Hold` | `Cancelled`

---

### `GET /api/productions` — Get All Productions

**Query Params:** `status`, `projectCode`, `lotNo`, `productionCode`, `user_id`, `page`, `limit`

> Returns a paginated list of production batches with optional filters. Use `status=In Progress` on the dashboard to show only active runs. The pagination object follows the same structure as timesheets.

**✅ Success `200`**
```json
{
  "success": true,
  "productions": [
    {
      "id": 3,
      "project_code": "001MABC001001",
      "pcb_code": "PCB-001",
      "lot_no": "LOT-001",
      "qty": "50",
      "status": "Scheduled",
      "prepare_person": "Raj Kumar",
      "dispatch_target_date": "30-04-2026",
      "bom_link": "https://drive.google.com/..."
    }
  ],
  "pagination": {
    "total": 20,
    "page": 1,
    "totalPages": 2,
    "hasNextPage": true
  }
}
```

---

### `POST /api/productions` — Create Production

> Schedules a new production batch. Requires a valid `pcb_code` and `project_code`. Upload associated files (BOM, Gerber) using `upload-file` and include the returned URL in the body.

**✅ Success `201`**
```json
{
  "success": true,
  "message": "Production created successfully",
  "production": { "id": 4, "lot_no": "LOT-002", "status": "Scheduled" }
}
```

---

### `POST /api/productions/upload-file` — Upload File

> Uploads any file (BOM spreadsheet, Gerber archive, stencil PDF, etc.) to Cloudinary under `productions/{lot_no}/`. Returns the download URL to store against the production record.

Form field: `file` (any file type)

**✅ Success `200`**
```json
{
  "success": true,
  "fileUrl": "https://res.cloudinary.com/.../productions/LOT-002/bom.xlsx"
}
```

---

### `PUT /api/productions/:id` — Update Production

> Updates production batch details — commonly used to advance the `status` (e.g. `Scheduled` → `In Progress`), update `qty`, or add file links after uploading new documents.

**✅ Success `200`**
```json
{ "success": true, "message": "Production updated successfully" }
```

**❌ Not Found `404`**
```json
{ "success": false, "message": "Production not found" }
```

---

---

## ⚠️ Issues — `/api/issues`

A lightweight internal notification system. When a requirement moves through workflow stages (e.g. a reviewer approves or a store person raises a discrepancy), an issue is created to alert the relevant user. Issues appear as notifications in the frontend header. Once actioned, the issue is deleted (resolved). Socket.IO broadcasts new issue events in real time.

---

### `GET /api/issues` — Get All Issues

**Query Params:** `receive_username`, `serial_number`

> Fetches issues for a specific user (`receive_username`) or for a specific requirement (`serial_number`). The frontend uses `receive_username=<current_user>` on page load to show the notification badge count.

**✅ Success `200`**
```json
{
  "success": true,
  "issues": [
    {
      "sr.no": 12,
      "serial_number": "RFQ-2603-001",
      "requirement_id": 42,
      "sender_username": "john.doe",
      "page_name": "In Store check",
      "notes": "Quantity mismatch found",
      "receive_username": "manager.xyz",
      "order_status": "Issue",
      "issue_order_status": "Normal",
      "date": "2026-03-07"
    }
  ]
}
```

---

### `POST /api/issues` — Create Issue

> Creates a notification issue targeting a specific user (`receive_username`). Called automatically by the frontend when a requirement status changes and needs another person's attention. The `page_name` field indicates which page/step triggered the alert.

**Request Body:**
```json
{
  "serial_number": "RFQ-2603-001",
  "requirement_id": 42,
  "sender_username": "john.doe",
  "page_name": "In Store check",
  "notes": "Quantity mismatch found",
  "receive_username": "manager.xyz",
  "order_status": "Issue",
  "issue_order_status": "Normal"
}
```

**✅ Success `201`**
```json
{
  "success": true,
  "message": "Issue created successfully",
  "issue": { "sr.no": 13, "serial_number": "RFQ-2603-001" }
}
```

---

### `DELETE /api/issues/:id` — Resolve / Delete Issue

> Marks an issue as resolved by deleting it. Called when the recipient user acknowledges and actions the notification. There is no separate "mark as read" — deletion is the resolution mechanism.

**✅ Success `200`**
```json
{ "success": true, "message": "Issue deleted successfully" }
```

**❌ Not Found `404`**
```json
{ "success": false, "message": "Issue not found" }
```

---

---

## 🗂️ Categories — `/api/categories`

Defines the hierarchical work-category tree used to classify timesheet entries and projects. Top-level categories carry a single `letter` code (e.g. `M` = Management, `P` = Production, `H` = HR). Sub-categories reference a `parent_id`. The letter is embedded in project codes for quick identification.

---

### `GET /api/categories` — Get All Categories

> Returns the full category tree (flat list with `parent_id` references). The frontend builds the hierarchical dropdown from this list.

**✅ Success `200`**
```json
{
  "success": true,
  "categories": [
    { "id": 1, "letter": "M", "name": "Management", "parent_id": null, "is_active": true },
    { "id": 2, "letter": null, "name": "Executive", "parent_id": 1, "is_active": true }
  ]
}
```

### `POST /api/categories` — Create

> Adds a new category or sub-category. Set `parent_id: null` for a top-level category and provide a `letter`. For a sub-category, set `parent_id` to the parent's `id` and leave `letter` as `null`.

```json
{ "letter": "P", "name": "Production", "parent_id": null }
```

**✅ `201`** `{ "success": true, "message": "Category created successfully", "category": { "id": 5 } }`

### `PUT /api/categories/:id` — Update

> Updates a category's name, letter, or active status. Changing the `letter` of a top-level category does **not** retroactively update existing project codes — change with caution.

**✅ `200`** `{ "success": true, "message": "Category updated successfully" }`

**❌ `404`** `{ "success": false, "message": "Category not found" }`

### `DELETE /api/categories/:id`

> Removes a category. Sub-categories whose `parent_id` pointed to this entry will have a dangling reference — ensure all children are removed or re-parented first.

**✅ `200`** `{ "success": true, "message": "Category deleted successfully" }`

---

---

## 🏛️ Departments — `/api/departments`

Maintains the list of departments used to organise staff. Users are assigned to a department, and departments can be used to filter or group timesheets and project assignments.

---

### `GET /api/departments`

> Returns all departments. Used to populate the department dropdown in the User Management and Profile pages.

**✅ `200`**
```json
{
  "success": true,
  "departments": [
    { "id": 1, "name": "IT", "description": "Information Technology", "is_active": true }
  ]
}
```

### `POST /api/departments`

> Creates a new department. Department names must be unique. The `description` field is optional.

```json
{ "name": "Design", "description": "Product Design department" }
```

**✅ `201`** `{ "success": true, "message": "Department created successfully" }`

**❌ `400`** `{ "success": false, "message": "Department name already exists" }`

---

---

## 📐 Units — `/api/units`

Stores the units of measurement used in requirement (R2R) records, e.g. `PCS`, `KG`, `BOX`, `SET`. Default units are seeded on first startup. Custom units can be added at any time.

---

### `GET /api/units`

> Returns all active units of measurement. Used to populate the unit-of-measure dropdown in the requirement create/edit form.

**✅ `200`**
```json
{
  "success": true,
  "units": [
    { "id": 1, "unitname": "PCS", "is_active": true },
    { "id": 2, "unitname": "KG", "is_active": true }
  ]
}
```

### `POST /api/units`

> Adds a new unit of measurement. `unitname` must be unique (case-insensitive).

```json
{ "unitname": "MTR" }
```

**✅ `201`** `{ "success": true, "message": "Unit created successfully", "unit": { "id": 5, "unitname": "MTR" } }`

**❌ `400`** `{ "success": false, "message": "Unit name already exists" }`

---

---

## ⚙️ Settings — `/api/settings`

A key-value store for global application configuration. Seeded with defaults on startup. Currently controls the requirement serial number `prefix` (`RFQ`) and year format. Settings can be changed at runtime without restarting the server.

---

### `GET /api/settings`

> Returns all application settings as a key-value list. Used by the Settings admin page and by the requirement serial-number generator to read the active prefix.

**✅ `200`**
```json
{
  "success": true,
  "settings": [
    { "id": 1, "key": "serial_prefix", "value": "RFQ" },
    { "id": 2, "key": "serial_year_format", "value": "YYYY" }
  ]
}
```

### `GET /api/settings/:key`

> Fetches a single setting by its key string (e.g. `serial_prefix`). Useful when only one value is needed.

**✅ `200`**
```json
{ "success": true, "setting": { "key": "serial_prefix", "value": "RFQ" } }
```

**❌ `404`**
```json
{ "success": false, "message": "Setting not found" }
```

### `PUT /api/settings/:key`

> Updates the `value` for a given setting key. Changes take effect immediately for all subsequent API calls (e.g. changing `serial_prefix` to `PO` will generate `PO-YYMM-NNN` serials from that point on).

```json
{ "value": "PO" }
```

**✅ `200`** `{ "success": true, "message": "Setting updated successfully" }`

---

---

## 📅 Financial Years — `/api/financial-years`

Defines the financial year ranges used to filter and group projects. Each financial year has a short `code` (e.g. `25-26`) and a human-readable `label`. Project codes embed the financial year for quick identification.

---

### `GET /api/financial-years`

**✅ `200`**
```json
{
  "success": true,
  "financialYears": [
    { "id": 1, "code": "25-26", "label": "FY 2025-2026", "start_date": "2025-04-01", "end_date": "2026-03-31" }
  ]
}
```

### `POST /api/financial-years`

> Creates a new financial year entry. The `code` must be unique. Dates should follow `YYYY-MM-DD` format. Adding a new year makes it immediately available in all project filters.

```json
{ "code": "26-27", "label": "FY 2026-2027", "start_date": "2026-04-01", "end_date": "2027-03-31" }
```

**✅ `201`** `{ "success": true, "message": "Financial year created successfully" }`

---

---

## 💚 Health Check — `/api/health`

A lightweight endpoint to verify the API server is running. Does **not** check database connectivity — use it for load-balancer or uptime-monitor pings.

---

### `GET /api/health`

**✅ `200`**
```json
{ "status": "ok", "timestamp": "2026-03-07T12:34:56.789Z" }
```

---

---

## 🌐 Real-time Events (Socket.IO)

WebSocket connects to: `ws://localhost:5000`

| Event | Triggered When |
|-------|----------------|
| `project-update` | Project created, updated, or deleted |

**Client receives:**
```json
{
  "event": "project-update",
  "action": "created",
  "data": { "id": 13, "project_code": "002MABC002001", "status": "In Planning" }
}
```

---

## 🛠️ Utilities (`src/utils/project.utils.js`)

| Function | Description |
|----------|-------------|
| `calculateDurationFromTimes(start, stop)` | Returns `{ hours, minutes, seconds }` |
| `formatDurationHHMMSS(h, m, s)` | Returns `"08:30:00"` string |
| `calculateCommonTime(timesheets)` | Sweep-line O(n log n) overlap finder |
| `calculateProjectWorkHour(projectCode)` | Sum all durations for a project |
| `calculateProjectNetTime(projectCode)` | Net time after removing overlaps |
| `normalizeTimeFormat(str)` | Normalizes `"8h30m"` → `"8h 30m"` |
#   G o o g l e _ C h a t  
 