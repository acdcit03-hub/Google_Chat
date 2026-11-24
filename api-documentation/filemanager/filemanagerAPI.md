# File Manager API

Base URL: `/api/file-manager`

All endpoints return JSON except `GET /files/:id/download`, which returns the file binary on success.

## Overview

| Topic | Behavior |
|---|---|
| Storage root | **Only** `FILEMANAGER_PATH` from `.env` (e.g. `D:\NASTEST`). No `/uploads` fallback. |
| Item location | Stored in `relative_path` under that root (e.g. `RRK/Invoices/file.pdf`). |
| `filemanager_path` column | Always the configured root path only (not the full item path). |
| Listing scope | Responses include **only** rows for the **current** `FILEMANAGER_PATH`. Old path rows (e.g. previous `/uploads`) are ignored. |
| Disk sync | List endpoints sync live folders/files from disk under `FILEMANAGER_PATH` into the DB before returning data. |
| Admin (`access === 1`) | Can view/manage **all** user folders under the storage root. |
| Non-admin | Can only access their **own** user root folder and its children. |
| Own folder name | Always the sanitized **username**. Custom names for the personal root are rejected. |
| Duplicate names | Checked only within the **same parent** + **same username** + **same `filemanager_path`**. Same filename is allowed in different folders or under a different storage path. |
| Recycle Bin | Physical folder at `FILEMANAGER_PATH/Recycle Bin/{username}/…`. Admin `GET /recycle-bin` lists **user folders** first; `?username=` opens that folder’s deleted items. Non-admin: own deletions only. |
| Google Sheet | Cloud file via Sheets/Drive API. Stores `file_source=google_sheet` plus a physical `.url` shortcut under the parent folder on NAS. Requires folder `google_drive_folder_id`. |
| Google Doc | Cloud file via Drive API. Stored with `file_source=google_doc`. Same parent Drive-folder rules as Sheets. |
| `public_id` | Unique URL-safe id on every item (16 random bytes → base64url, ~22 chars, e.g. `1n7Eiy0YN-hERtdvu9Xecf`). Generated on create; backfilled for existing rows. Use for shareable links instead of numeric `id`. |

## Authentication and Headers

Identity comes from the JWT attached by `attachUserFromToken` (`req.user.id`, `req.user.username`, `req.user.access`). Development fallbacks from `audit.utils.js` may also apply.

| Header | Required by | Description |
|---|---|---|
| `Authorization: Bearer <token>` | All endpoints | Preferred auth. JWT should include `id`, `username`, and `access`. |
| `x-user-id` | Fallback | Numeric user ID if JWT is not used in local testing. |
| `x-username` | Fallback / create flows | Username for root folder name and audit fields. |
| `Content-Type: application/json` | JSON bodies | Required for JSON payloads. |
| `Content-Type: multipart/form-data` | File upload | Required for `POST /files/upload`; field name `file` (one or many) or `files`. |

> Use application authentication in production. Do not allow clients to spoof identity headers.

## Environment

| Variable | Required | Description |
|---|---:|---|
| `FILEMANAGER_PATH` | Yes* | Absolute storage root (e.g. `D:\NASTEST`). Preferred. |
| `FILE_MANAGER_ROOT_PATH` | Yes* | Alias for the same storage root if `FILEMANAGER_PATH` is unset. |
| `FILE_MANAGER_MAX_BYTES` | No | Max upload size in bytes. Default `52428800` (50 MiB). |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REDIRECT_URI` | For user OAuth tokens | Used with `user_google_tokens` or `GOOGLE_REFRESH_TOKEN`. |
| `GOOGLE_REFRESH_TOKEN` | No | Shared OAuth refresh token fallback. |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | No | Service-account JSON (Drive+Sheets scopes) — same pattern as Employee import. |

\* One of `FILEMANAGER_PATH` or `FILE_MANAGER_ROOT_PATH` is required.

## Common Response Shapes

### Success

```json
{
  "success": true,
  "data": {},
  "filemanager_path": "D:/NASTEST",
  "is_admin": false
}
```

- List endpoints: `data` is an array.
- Many list/check endpoints also return `filemanager_path` (current env root) and `is_admin`.

### Item object (typical fields)

```json
{
  "id": 201,
  "public_id": "1n7Eiy0YN-hERtdvu9Xecf",
  "owner_id": 3,
  "username": "RRK",
  "parent_id": 14,
  "name": "3d-select.jpg",
  "item_type": "file",
  "storage_name": "3d-select.jpg",
  "relative_path": "RRK/3d-select.jpg",
  "filemanager_path": "D:/NASTEST",
  "mime_type": "image/jpeg",
  "extension": "jpg",
  "size": 29679,
  "created_by": "RRK",
  "updated_by": "RRK",
  "created_at": "2026-09-09T04:29:57.938Z",
  "updated_at": "2026-09-09T04:29:57.938Z",
  "is_deleted": false,
  "deleted_at": null,
  "deleted_by": null,
  "original_path": null,
  "recycle_path": null
}
```

### Failure

```json
{
  "success": false,
  "message": "Error description"
}
```

| Status | Meaning |
|---:|---|
| `400` | Invalid/missing data, or protected operation. |
| `401` | User id/username missing. |
| `403` | Access denied (non-admin accessing another user's item). |
| `404` | Item, parent, or physical file missing. |
| `409` | Duplicate own folder, or sibling name already exists for same parent + username + path. |
| `413` | Upload exceeds size limit. |
| `500` | Unexpected server/storage/database failure. |

---

## 1. Check My Folder

**API name:** Get my folder  
**Method:** `GET /my-folder`  
**Description:** Checks whether the logged-in user already has a personal root folder under the current `FILEMANAGER_PATH`. **Does not create** a folder. Syncs top-level disk entries first.

**Payload:** None.

**Success — folder exists (`200 OK`):**

```json
{
  "success": true,
  "exists": true,
  "data": {
    "id": 14,
    "owner_id": 3,
    "username": "RRK",
    "parent_id": null,
    "name": "RRK",
    "item_type": "folder",
    "relative_path": "RRK",
    "filemanager_path": "D:/NASTEST"
  },
  "storage_path": "D:\\NASTEST\\RRK",
  "filemanager_path": "D:/NASTEST",
  "is_admin": false
}
```

**Success — folder missing (`200 OK`):**

```json
{
  "success": true,
  "exists": false,
  "data": null,
  "suggested_name": "RRK",
  "filemanager_path": "D:/NASTEST",
  "is_admin": false,
  "message": "Your folder was not found. You can create it."
}
```

Also returns `exists: false` when a DB row exists but the folder is missing on disk under `FILEMANAGER_PATH`.

**Failed responses:** `401`, `500`.

---

## 2b. Recycle Bin

Uses the existing `file_manager_items` table (no separate Recycle Bin table).

| Column | Role |
|---|---|
| `is_deleted` | Soft-delete flag |
| `deleted_at` | When it was deleted |
| `deleted_by` | Username who deleted it (**separate from `owner_id`**) |
| `original_path` | `relative_path` **before** delete |
| `recycle_path` | `Recycle Bin/{username}/…` after delete (owner’s Recycle Bin folder) |

**On delete (file or folder):** physical move to:

`{FILEMANAGER_PATH|FILE_MANAGER_ROOT_PATH}/Recycle Bin/{username}/…`  
(e.g. delete `TKA/requirement.docx` → store in `Recycle Bin/TKA/requirement.docx`; DB `parent_id` points at that user’s Recycle Bin folder row)

Example: `TKA/docs/file.pdf` → `Recycle Bin/TKA/docs/file.pdf`

Then DB sets `original_path`, `recycle_path`, `is_deleted`, `deleted_at`, `deleted_by`. `owner_id` / `username` stay as the item owner.

### List Recycle Bin

**API name:** Get recycle bin  
**Method:** `GET /recycle-bin`  
**Description:** Returns Recycle Bin contents. Matches disk layout under `Recycle Bin/{username}/…` (e.g. `AAM`, `TMM`).

**Access / views:**
- **Admin, no filter:** user folders (`view: "user_folders"`) — like Explorer opening `Recycle Bin` and seeing `AAM`, `TMM`.
- **Admin + `?username=TMM`:** deleted items for that user folder (`view: "items"`).
- **Non-admin:** own deleted items only (`view: "items"`).
- **Admin + `?flat=true`:** all top-level deleted items (skip user-folder grouping).

**Query parameters:**

| Parameter | Required | Description |
|---|---:|---|
| `username` | No | Open one user folder / filter by owner username. Alias: `user`. |
| `deleted_by` | No | Filter by who deleted the item. Alias: `deletedBy`. |
| `flat` | No | `true` — admin flat item list (no user folders). |

**Examples:**
- `GET /recycle-bin` (admin) → user folders `AAM`, `TMM`, …
- `GET /recycle-bin?username=TMM` (admin) → deleted items under TMM
- `GET /recycle-bin` (user) → that user’s deleted items
- `GET /recycle-bin?flat=true` (admin) → all deleted items flat

**Admin root — all user Recycle Bin folders (`200 OK`):**

```json
{
  "success": true,
  "view": "user_folders",
  "data": [
    {
      "id": 101,
      "item_type": "folder",
      "name": "AAM",
      "username": "AAM",
      "owner_id": 3,
      "parent_id": 100,
      "relative_path": "Recycle Bin/AAM",
      "deleted_count": 2,
      "deleted_at": "2026-09-10T12:13:00.000Z",
      "latest_deleted_at": "2026-09-10T12:13:00.000Z",
      "is_deleted": false,
      "thumbnail_available": false,
      "thumbnail_url": null
    },
    {
      "id": 102,
      "item_type": "folder",
      "name": "TMM",
      "username": "TMM",
      "owner_id": 5,
      "parent_id": 100,
      "relative_path": "Recycle Bin/TMM",
      "deleted_count": 0,
      "is_deleted": false
    }
  ],
  "filters": { "username": null, "deleted_by": null },
  "filemanager_path": "D:/NASTEST",
  "is_admin": true
}
```

Frontend: clicking folder `TMM` → `GET /recycle-bin?username=TMM`.

Admin `GET /recycle-bin` always ensures every user root has a `Recycle Bin/{username}` folder, then returns **all** of them (empty folders included).

**Items view (`200 OK`):**

```json
{
  "success": true,
  "view": "items",
  "data": [
    {
      "id": 336,
      "name": "Animations.docx",
      "item_type": "file",
      "username": "TMM",
      "original_path": "TMM/Animations.docx",
      "recycle_path": "Recycle Bin/TMM/Animations.docx",
      "is_deleted": true,
      "deleted_by": "TKA",
      "thumbnail_available": true,
      "thumbnail_url": "/api/file-manager/files/336/thumbnail"
    }
  ],
  "filters": { "username": "TMM", "deleted_by": null },
  "is_admin": true
}
```

Notes:
- Recycle Bin is a physical folder only — not a DB folder row.
- Disk example: `D:\NASTEST\Recycle Bin\AAM`, `D:\NASTEST\Recycle Bin\TMM`.

### Restore

**API name:** Restore from recycle bin  
**Method:** `POST /recycle-bin/:id/restore`  
**Description:** Moves the item (and deleted descendants) from `recycle_path` back to `original_path`, then clears `is_deleted`, `deleted_at`, `deleted_by`, `original_path`, and `recycle_path`. Only the user who deleted the item can restore it.

**Success (`200 OK`):**

```json
{
  "success": true,
  "message": "Item restored",
  "data": {
    "restored_count": 4,
    "item": { "id": 201, "is_deleted": false, "relative_path": "TKA/gfh", "deleted_by": null }
  }
}
```

**Failed responses:** `401`, `404`, `409` (target already exists), `500`.

### Permanent Delete

**API name:** Permanent delete from recycle bin  
**Method:** `DELETE /recycle-bin/:id`  
**Description:** Removes the physical files under the recycle path and hard-deletes the DB row(s) (item + deleted descendants). Only the user who deleted the item can permanently delete it.

**Success (`200 OK`):**

```json
{
  "success": true,
  "message": "Item permanently deleted",
  "data": {
    "deleted_count": 4,
    "id": 201
  }
}
```

**Failed responses:** `401`, `404`, `500`.

---

## 2. Create My Folder

**API name:** Ensure / create my folder  
**Method:** `POST /my-folder`  
**Description:** Creates the user's personal root folder **only if it does not already exist**. Folder name is always the username. Duplicate own folders are **not allowed**. Also creates/ensures:

1. Disk: `FILEMANAGER_PATH/Recycle Bin/{username}`
2. DB row: root folder `Recycle Bin` (`parent_id` null, `username: system`)
3. DB row: `Recycle Bin/{username}` for this user
4. DB + disk rows for **all** existing user roots under `Recycle Bin/{user}`

**Payload (`application/json`, optional):**

```json
{
  "name": "RRK"
}
```

- If `name` is omitted, username is used.
- If `name` is provided and differs from the username, the API returns `400`.

**Success — created (`201 Created`):**

```json
{
  "success": true,
  "exists": true,
  "created": true,
  "data": { "id": 14, "name": "RRK", "parent_id": null, "item_type": "folder" },
  "storage_path": "D:\\NASTEST\\RRK",
  "recycle_bin_path": "D:\\NASTEST\\Recycle Bin\\RRK",
  "recycle_bin_root": {
    "id": 100,
    "name": "Recycle Bin",
    "relative_path": "Recycle Bin",
    "username": "system",
    "parent_id": null
  },
  "recycle_bin_folder": {
    "id": 101,
    "name": "RRK",
    "relative_path": "Recycle Bin/RRK",
    "username": "RRK",
    "parent_id": 100
  },
  "filemanager_path": "D:/NASTEST",
  "is_admin": false
}
```

**Already exists (`409 Conflict`):**

```json
{
  "success": false,
  "exists": true,
  "created": false,
  "data": { "id": 14, "name": "RRK", "item_type": "folder" },
  "storage_path": "D:\\NASTEST\\RRK",
  "recycle_bin_path": "D:\\NASTEST\\Recycle Bin\\RRK",
  "recycle_bin_root": { "id": 100, "name": "Recycle Bin" },
  "recycle_bin_folder": { "id": 101, "name": "RRK", "relative_path": "Recycle Bin/RRK" },
  "filemanager_path": "D:/NASTEST",
  "is_admin": false,
  "message": "Your folder already exists. Duplicate own folder is not allowed."
}
```

Frontends should treat `409` as “open existing folder” (do not create again).

**Failed responses:**

- `400`: Own folder name must match username.
- `401`: Authentication required.
- `409`: Duplicate own folder.
- `500`: Create failed.

---

## 2a. List Google Sheets (user-wise)

**API name:** List Google Sheets  
**Method:** `GET /google-sheets`  
**Description:** Returns Google Sheets for the logged-in user — sheets they **created/own** in File Manager plus sheets in **project folders assigned** to them (any role: `owner` \| `editor` \| `viewer`). Deduped by source (`user_folder` | `project_folder`).

**Query:**

| Param | Description |
| --- | --- |
| `search` / `q` | Optional name/URL/project filter |
| `limit` | Max rows (default 100, max 500) |
| `source` | `all` (default), `user` / `my`, `project` / `assigned` |
| `all` | Admin only — list everyone’s sheets |

**Success (`200`):**

```json
{
  "success": true,
  "count": 2,
  "data": [
    {
      "id": 12,
      "name": "My BOM Sheet",
      "file_source": "google_sheet",
      "google_file_id": "1abc…",
      "url": "https://docs.google.com/spreadsheets/d/1abc…",
      "source": "user_folder"
    },
    {
      "id": 44,
      "name": "PROJECT_PCB",
      "project_code": "P-1001",
      "url": "https://docs.google.com/spreadsheets/d/1xyz…",
      "source": "project_folder"
    }
  ]
}
```

---

## 2b. Create Google Sheet

**API name:** Create Google Sheet  
**Method:** `POST /google-sheets`  
**Description:** Creates a Google Spreadsheet with the connected Google credentials, places it in the Drive folder mapped by the ERP parent’s `google_drive_folder_id`, writes a Windows `.url` Internet Shortcut into the parent’s physical folder under `FILEMANAGER_PATH`, and inserts a `file_manager_items` row (`file_source=google_sheet`). The Google file itself is not downloaded or duplicated.

**Payload:**

```json
{
  "name": "ABC Project Data",
  "parent_id": 45
}
```

**Success (`201 Created`):**

```json
{
  "success": true,
  "message": "Google Sheet created successfully",
  "data": {
    "id": 101,
    "name": "ABC Project Data",
    "item_type": "file",
    "file_source": "google_sheet",
    "parent_id": 45,
    "google_file_id": "1ABCXYZ...",
    "google_drive_folder_id": "1FOLDERXYZ...",
    "url": "https://docs.google.com/spreadsheets/d/1ABCXYZ.../edit",
    "mime_type": "application/vnd.google-apps.spreadsheet",
    "extension": "gsheet",
    "storage_name": "ABC Project Data.url",
    "relative_path": "TKA/ABC Project Data.url",
    "thumbnail_url": null,
    "preview_url": "https://docs.google.com/spreadsheets/d/1ABCXYZ.../edit"
  }
}
```

**Failed responses:**

| Status | When |
|---:|---|
| `400` | Missing name / parent_id; parent in Recycle Bin; parent missing `google_drive_folder_id` |
| `401` | Auth required, or Google account not connected |
| `403` | No permission on parent folder |
| `404` | Parent folder not found |
| `409` | Duplicate name in parent, or `.url` already exists on disk |
| `502` | Google API failure |

**Auth sources (backend only, never sent to frontend):** `user_google_tokens` → `GOOGLE_REFRESH_TOKEN` → `GOOGLE_SERVICE_ACCOUNT_JSON`.

**Physical shortcut:** `{FILEMANAGER_PATH}/{parent.relative_path}/{name}.url` containing `[InternetShortcut]` → Google Sheet URL. On delete, the `.url` file moves to Recycle Bin with the DB row.

---

## 2c. Create Google Doc

**API name:** Create Google Doc  
**Method:** `POST /google-docs`  
**Description:** Same flow as Google Sheet. Creates a Google Document in Drive (mapped by parent `google_drive_folder_id`), writes a `.url` shortcut on NAS, then inserts `file_manager_items` with `file_source=google_doc`.

**Payload:**

```json
{
  "name": "ABC Project Notes",
  "parent_id": 45
}
```

**Success (`201 Created`):**

```json
{
  "success": true,
  "message": "Google Doc created successfully",
  "data": {
    "id": 102,
    "name": "ABC Project Notes",
    "item_type": "file",
    "file_source": "google_doc",
    "parent_id": 45,
    "google_file_id": "1DOCXYZ...",
    "google_drive_folder_id": "1FOLDERXYZ...",
    "url": "https://docs.google.com/document/d/1DOCXYZ.../edit",
    "mime_type": "application/vnd.google-apps.document",
    "extension": "gdoc",
    "storage_name": "ABC Project Notes.url",
    "relative_path": "TKA/ABC Project Notes.url",
    "thumbnail_url": null,
    "preview_url": "https://docs.google.com/document/d/1DOCXYZ.../edit"
  }
}
```

**Failed responses:** same as Google Sheet (`400` / `401` / `403` / `404` / `409` / `502`).

---

## 2d. Create Shortcut

**API name:** Create shortcut  
**Method:** `POST /shortcuts`  
**Description:** Creates a Windows `.url` Internet Shortcut under the parent folder on `FILEMANAGER_PATH` and inserts a `file_manager_items` row. Does not download the target — only stores a local shortcut pointing at the given URL. Viewing the file redirects to that URL.

**Payload:**

```json
{
  "name": "ABC Project Data",
  "url": "https://docs.google.com/spreadsheets/d/1ABCXYZ.../edit",
  "parent_id": 45,
  "extension": "gsheet"
}
```

| Field | Required | Notes |
|---|---|---|
| `name` | yes | Display / file base name (saved as `{name}.url`) |
| `url` | yes | `http` / `https` target |
| `parent_id` | yes | Parent folder id |
| `extension` | yes | **Only** `gsheet`, `gdoc`, or `url` |

**Extension → stored type / MIME / thumbnail**

| `extension` | `file_source` | `mime_type` | Thumbnail |
|---|---|---|---|
| `gsheet` | `google_sheet` | `application/vnd.google-apps.spreadsheet` | Drive export preview (URL must be a Sheets link) |
| `gdoc` | `google_doc` | `application/vnd.google-apps.document` | Drive export preview (URL must be a Docs link) |
| `url` | `shortcut` | `application/internet-shortcut` | Generic URL icon |

**Success (`201 Created`):**

```json
{
  "success": true,
  "message": "Shortcut created successfully",
  "data": {
    "id": 120,
    "name": "ABC Project Data",
    "item_type": "file",
    "file_source": "google_sheet",
    "parent_id": 45,
    "url": "https://docs.google.com/spreadsheets/d/1ABCXYZ.../edit",
    "google_file_id": "1ABCXYZ...",
    "mime_type": "application/vnd.google-apps.spreadsheet",
    "extension": "gsheet",
    "storage_name": "ABC Project Data.url",
    "relative_path": "TKA/ABC Project Data.url",
    "thumbnail_available": true,
    "thumbnail_url": "/api/file-manager/files/120/thumbnail"
  }
}
```

**Failed responses:**

| Status | When |
|---:|---|
| `400` | Missing name / url / parent_id / extension; invalid extension; invalid url; gsheet/gdoc URL missing Google file id; parent in Recycle Bin |
| `401` | Auth required |
| `403` | No permission on parent folder |
| `404` | Parent folder not found |
| `409` | Duplicate name in parent, or `.url` already exists on disk |

---

## 3. Create Folder

**API name:** Create folder  
**Method:** `POST /folders`  
**Description:** Creates a subfolder under a parent. Ownership follows the **parent** folder (admin creating under another user keeps that user's `owner_id` / `username`).

**Payload (`application/json`):**

```json
{
  "name": "Invoices",
  "parent_id": 14
}
```

- `name` is required.
- If `parent_id` is omitted/`null`, the folder is created under the caller's own root (must exist via `POST /my-folder`).

**Success (`201 Created`):**

```json
{
  "success": true,
  "data": {
    "id": 20,
    "owner_id": 3,
    "username": "RRK",
    "parent_id": 14,
    "name": "Invoices",
    "item_type": "folder",
    "relative_path": "RRK/Invoices",
    "filemanager_path": "D:/NASTEST"
  }
}
```

**Failed responses:**

- `400`: Folder name required / user root not found.
- `401` / `403` / `404`
- `409`: `A folder or file with this name already exists here` (same parent + username + current path only)
- `500`

---

## 4. List Folder Children

**API name:** Get folder children  
**Method:** `GET /folders/:id/children`  
**Description:** Returns immediate children of a folder for the **current `FILEMANAGER_PATH` only**. Syncs that directory from disk first. Sync unique conflicts are swallowed so listing does not fail. Results are **paginated**.

**Path parameters:** `id` — folder ID.

**Query parameters:**

| Param | Required | Description |
|---|---|---|
| `page` | No | 1-based page (default `1`) |
| `limit` | No | Page size (default `48`, max `200`) |
| `item_type` | No | `folder` or `file` to filter |

**Success (`200 OK`):**

```json
{
  "success": true,
  "data": [
    {
      "id": 201,
      "parent_id": 14,
      "name": "3d-select.jpg",
      "item_type": "file",
      "relative_path": "RRK/3d-select.jpg",
      "filemanager_path": "D:/NASTEST"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 48,
    "total": 185,
    "total_pages": 4,
    "has_more": true,
    "offset": 0
  },
  "filemanager_path": "D:/NASTEST",
  "is_admin": false
}
```

Frontend should display `data` and use `pagination.has_more` / `page` for Load more.

Admin: all children under the folder (current path).  
Non-admin: only their `owner_id` children.

**Failed responses:** `401`, `403`, `404`, `500`.

---

## 5. Get Folder

**API name:** Get folder details  
**Method:** `GET /folders/:id`  
**Description:** Returns metadata for one accessible folder.

**Success (`200 OK`):** `{ "success": true, "data": { ...folder } }`

**Failed responses:** `401`, `403`, `404`, `500`.

---

## 6. Update Folder (Rename)

**API name:** Rename folder  
**Method:** `PUT /folders/:id`  
**Description:** Renames a non-root folder and rewrites descendant `relative_path` values. User root cannot be renamed.

**Payload:**

```json
{ "name": "Archived Invoices" }
```

**Success (`200 OK`):** `{ "success": true, "data": { ...updated folder } }`

**Failed responses:** `400` (root rename / name required), `401`, `403`, `404`, `409`, `500`.

---

## 7. Delete Folder

**API name:** Delete folder  
**Method:** `DELETE /folders/:id`  
**Description:** Moves the folder into that owner’s Recycle Bin on disk (`Recycle Bin/{username}/…`), sets DB `parent_id` to the user’s Recycle Bin folder row, then soft-deletes it and all descendants (`is_deleted`, `deleted_at`, `deleted_by`, `original_path`, `recycle_path`). `owner_id` is unchanged. User root cannot be deleted.

**Success (`200 OK`):**

```json
{
  "success": true,
  "message": "Folder moved to Recycle Bin",
  "data": {
    "deleted_count": 4,
    "item": { "id": 20, "is_deleted": true, "deleted_by": "TKA", "original_path": "TKA/docs", "recycle_path": "Recycle Bin/TKA/docs" }
  }
}
```

**Failed responses:** `400 Cannot delete the user root folder`, `401`, `403`, `404`, `409`, `500`.

---

## 8. Upload File

**API name:** Upload file  
**Method:** `POST /files/upload`  
**Description:** Uploads one or many files into a parent folder under `FILEMANAGER_PATH`. Storage uses the **real filename** (not a UUID). Default max size 50 MiB per file (`FILE_MANAGER_MAX_BYTES`). Max files per request: `FILE_MANAGER_MAX_FILES` (default 200).

**Payload (`multipart/form-data`):**

| Field | Type | Required | Description |
|---|---|---:|---|
| `file` | File / File[] | Yes* | One or more files with field name `file` (repeat the field). |
| `files` | File[] | Yes* | Alternate field name for multiple files (same as `file`). |
| `parent_id` | Integer | No | Destination folder. Defaults to caller's root. |
| `name` | String | No | Display/storage name override — **only applied when uploading a single file**. Defaults to original filename. |

\* Provide at least one file via `file` and/or `files`.

**Success — single file (`201 Created`):**

```json
{
  "success": true,
  "data": { "id": 201, "name": "a.pdf", "item_type": "file" },
  "counts": { "uploaded": 1, "skipped": 0, "errors": 0, "total_files": 1 }
}
```

**Success — multiple files (`201 Created`):**

```json
{
  "success": true,
  "message": "2 of 3 file(s) uploaded",
  "data": [
    { "id": 201, "name": "a.pdf", "item_type": "file" },
    { "id": 202, "name": "b.png", "item_type": "file" }
  ],
  "skipped": [{ "name": "a.pdf", "reason": "A folder or file with this name already exists here" }],
  "errors": [],
  "counts": { "uploaded": 2, "skipped": 1, "errors": 0, "total_files": 3 }
}
```

Duplicates / disk conflicts are listed in `skipped` (other files still upload). Per-file failures go to `errors`.

**Failed responses:** `400`, `401`, `403`, `404`, `409` (none uploaded), `413`, `500`.

---

## 8b. Upload Folder

**API name:** Upload folder  
**Method:** `POST /files/upload-folder`  
**Description:** Uploads many files while preserving relative folder structure. Creates missing subfolders under the destination parent. Uses the same auth, ownership, path, and duplicate rules as single-file upload.

**Payload (`multipart/form-data`):**

| Field | Type | Required | Description |
|---|---|---:|---|
| `files` | File[] | Yes | One or more files (`files` field, max 200 by default / `FILE_MANAGER_MAX_FILES`). |
| `paths` | String / JSON array | Recommended | Relative paths aligned with `files` (e.g. `["Docs/a.pdf","Docs/img/b.png"]`). If omitted, each file's `originalname` is used. |
| `parent_id` | Integer | No | Destination folder ID. Defaults to caller's root. |
| `folder_name` | String | No | Optional wrapper folder created under parent; all uploaded paths go inside it. |

**Postman example**

1. Method: `POST` `/api/file-manager/files/upload-folder`
2. Headers: `Authorization: Bearer <token>`
3. Body → form-data:
   - `parent_id` = `14`
   - `folder_name` = `ProjectPack` (optional)
   - `paths` = `["readme.txt","images/logo.png"]`
   - `files` = select file 1
   - `files` = select file 2  
   (same key `files` for each file)

**Success (`201 Created`):**

```json
{
  "success": true,
  "message": "Uploaded 2 file(s)",
  "data": {
    "parent_id": 14,
    "uploaded": [ { "id": 210, "name": "readme.txt", "item_type": "file" } ],
    "folders_created": [ { "id": 209, "name": "images", "relative_path": "RRK/images" } ],
    "skipped": [],
    "errors": [],
    "counts": {
      "uploaded": 2,
      "folders_created": 1,
      "skipped": 0,
      "errors": 0,
      "total_files": 2
    }
  },
  "filemanager_path": "D:/NASTEST"
}
```

Duplicates / missing disk conflicts are listed in `skipped` (other files still upload). Per-file failures go to `errors`.

**Failed responses:** `400` (no files / paths mismatch / root missing), `401`, `403`, `404`, `409` (wrapper name clash with a file), `413`, `500`.

---

## 9. Download File

**API name:** Download file  
**Method:** `GET /files/:id/download`  
**Description:** Always downloads an accessible file as an attachment from `FILEMANAGER_PATH` (or `FILE_MANAGER_ROOT_PATH`) + `relative_path`. The saved filename uses the proper display **`name`** (never a UUID `storage_name`).

**Success (`200 OK`):** Binary body with `Content-Disposition: attachment; filename="<name>"`.

**Failed responses:** `401`, `403`, `404` (`File not found` / `Physical file missing on storage`), `500`.

---

## 9b. View / Preview File

**API name:** View file  
**Method:** `GET /files/:id/view`  
**Description:** Serves a file for browser preview/download based on the `extension` column. Physical path is `FILEMANAGER_PATH|FILE_MANAGER_ROOT_PATH + relative_path` (path traversal blocked). Requires authentication; non-admin users can only view their own files.

| Extension | Category | Disposition | Example Content-Type |
|---|---|---|---|
| `jpg`, `jpeg`, `png`, `ico`, `gif`, `webp`, … | image | `inline` | `image/jpeg`, `image/png` |
| `mp4`, `mov`, `webm`, … | video | `inline` | `video/mp4`, `video/quicktime` |
| `pdf` | pdf | `inline` | `application/pdf` |
| `mp3`, `wav`, `ogg`, `m4a`, … | audio | `inline` | `audio/mpeg` |
| `url` | url | redirect | `application/internet-shortcut` |
| `doc`, `docx`, `xls`, `xlsx`, `ppt`, `pptx`, … | office / spreadsheet | JSON (not streamed) | Use `/download` |
| other | download | JSON (not streamed) | Use `/download` |

**Non-viewable files (docx / xlsx / ppt / csv / zip / etc.):** `/view` never downloads and never returns a `download_url`. Response:

```http
HTTP/1.1 415 Unsupported Media Type
Content-Type: application/json
```

```json
{
  "success": false,
  "viewable": false,
  "name": "attendance.xlsx",
  "extension": "xlsx",
  "message": "This file cannot be viewed"
}
```

Frontend must show this message only. Do **not** call `/download` from the view flow.

**`.url` Internet Shortcut:** Reads the file (Windows format with `URL=…`), then **HTTP 302 redirects** to that target. Only `http` / `https` targets are allowed. With `?meta=true`, returns JSON including `redirect_url` instead of redirecting.

**Path parameters:** `id` — file ID.

**Headers on success:**

- `Content-Type` — resolved MIME (not set on `.url` redirect)
- `Content-Disposition` — `inline` or `attachment` with filename
- `X-Content-Type-Options: nosniff`
- `X-File-Category` — `image` \| `video` \| `pdf` \| `audio` \| `url` \| `office` \| `download`
- `X-File-Extension` — normalized extension
- `X-Redirect-Url` — target URL (`.url` redirect responses only)
- `Accept-Ranges: bytes` — for video/audio

**Success (`200 OK`):** Binary file stream.  
**Success (`.url`):** `302 Found` → `Location: <target url>`

**Optional metadata (no binary / no redirect):**

```http
GET /api/file-manager/files/201/view?meta=true
Authorization: Bearer <token>
```

Use `?meta=true` when the client needs JSON (e.g. to read `redirect_url` and open it in a new tab). Do not rely on `Accept: application/json` — that no longer switches to meta mode.
```json
{
  "success": true,
  "data": {
    "id": 201,
    "name": "3d-select.jpg",
    "extension": "jpg",
    "category": "image",
    "mime_type": "image/jpeg",
    "disposition": "inline",
    "inline": true,
    "size": 29679,
    "relative_path": "RRK/3d-select.jpg",
    "filemanager_path": "D:/NASTEST",
    "view_url": "/api/file-manager/files/201/view",
    "download_url": "/api/file-manager/files/201/download"
  }
}
```

**`.url` metadata example:**

```json
{
  "success": true,
  "data": {
    "id": 310,
    "name": "docs.url",
    "extension": "url",
    "category": "url",
    "mime_type": "application/internet-shortcut",
    "disposition": "inline",
    "inline": true,
    "redirect_url": "https://example.com/page",
    "view_url": "/api/file-manager/files/310/view",
    "download_url": "/api/file-manager/files/310/download"
  }
}
```

**Failed responses:** `400` (not a file / invalid `.url` target), `401`, `403`, `404` (missing / soft-deleted / not on disk), `500`.

**Note:** Prefer this endpoint for previews (`<img>`, `<video>`, PDF viewer). For `.url`, open the view URL in the browser (or use `redirect_url` from meta). Use `/download` when the client must always force a save.

---

## 9c. Thumbnail

**API name:** Get thumbnail  
**Method:** `GET /files/:id/thumbnail`  
**Description:** Returns a **Google Drive-style thumbnail image binary** for grid cards. Uses `FILEMANAGER_PATH|FILE_MANAGER_ROOT_PATH + relative_path` (path traversal blocked). Auth + ownership required. Never returns the original file and never exposes filesystem paths.

Thumbnails are **cached** under `{storage}/.fm-thumbnails/` (or `FILE_MANAGER_THUMB_CACHE`) keyed by file id + mtime/size hash so they are not regenerated on every request.

Works for active files **and Recycle Bin** soft-deleted files (uses `recycle_path` on disk; allowed for the user who deleted the item, the owner, or admin).

| Source type | Thumbnail generation |
|---|---|
| Images (`jpg`, `jpeg`, `png`, `gif`, `webp`, `svg`, `bmp`, `tif`, `tiff`, `ico`) | Resized WebP (aspect ratio preserved, ~300–600px wide) |
| Excel (`xls`, `xlsx`, `xlsm`, `csv`) | First sheet rendered as a table image |
| Word (`docx`; `doc` via LibreOffice if installed) | First-page style document image |
| PowerPoint (`pptx`; `ppt` via LibreOffice if installed) | First-slide style image |
| PDF | First page rendered to WebP |
| Text (`txt`) | First section rendered as a document image |
| Unsupported / generation failure | HTTP `422` JSON (see below) |

Optional: set `LIBREOFFICE_PATH` to a `soffice` binary for better `.doc` / `.ppt` conversion.

**Success (`200 OK`):**

```http
200 OK
Content-Type: image/webp
Cache-Control: public, max-age=86400
```

Response body: WebP binary (use directly in `<img src={thumbnail_url}>`).

**Failure (`422 Unprocessable Entity`):**

```json
{
  "success": false,
  "message": "Thumbnail is not available for this file type."
}
```

**Failed responses:** `401`, `403`, `404`, `422`, `500`.

---

## 10. Get File

**API name:** Get file details  
**Method:** `GET /files/:id`  
**Description:** Returns file metadata plus thumbnail / view / download URLs.

**Success (`200 OK`):**

```json
{
  "success": true,
  "data": {
    "id": 226,
    "name": "attendance.xlsx",
    "extension": "xlsx",
    "mime_type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "thumbnail_available": true,
    "thumbnail_url": "/api/file-manager/files/226/thumbnail",
    "view_url": "/api/file-manager/files/226/view",
    "download_url": "/api/file-manager/files/226/download"
  }
}
```

List endpoints (`GET /items`, `GET /folders/:id/children`, `GET /search`) also include `thumbnail_available` and `thumbnail_url` on each file row.

**Failed responses:** `401`, `403`, `404`, `500`.

---

## 11. Update File (Rename)

**API name:** Rename file  
**Method:** `PUT /files/:id`  
**Description:** Renames a file on disk and in the DB (updates `name`, `storage_name`, `relative_path`).

**Payload:**

```json
{ "name": "3d-select-final.jpg" }
```

**Success (`200 OK`):** `{ "success": true, "data": { ...updated file } }`

**Failed responses:** `400`, `401`, `403`, `404`, `409`, `500`.

---

## 12. Delete File

**API name:** Delete file  
**Method:** `DELETE /files/:id`  
**Description:** Moves the file into that owner’s Recycle Bin on disk (`Recycle Bin/{username}/…`), sets DB `parent_id` to the user’s Recycle Bin folder row, then soft-deletes it (`is_deleted`, `deleted_at`, `deleted_by`, `original_path`, `recycle_path`). `owner_id` is unchanged. If the Recycle Bin already contains a file with the same name, it is kept as `name(1).ext`, `name(2).ext`, … instead of failing. Restoring **keeps that current bin name** (e.g. `success(2).png` restores as `success(2).png` in the original folder, not `success.png`); if that name is also taken there, the next increment (`success(3).png`, …) is used.

**Success (`200 OK`):** `{ "success": true, "message": "File moved to Recycle Bin", "data": { "id": 201, "is_deleted": true, "deleted_by": "TKA", "original_path": "TKA/file.pdf", "recycle_path": "Recycle Bin/TKA/file.pdf" } }`

**Failed responses:** `401`, `403`, `404`, `409`, `500`.

---

## 12A. Permanent Delete File or Folder

**API name:** Permanent delete file / folder (common, by id)  
**Method:** `DELETE /api/file-manager/items/:id/permanent?confirm=true`

One common API for both files and folders — the server detects `item_type` from the `id` (`file` → deletes that file, `folder` → deletes the folder and everything inside it). There are no separate file/folder permanent-delete routes.

**Description:** **Permanently** deletes the item — the physical file/folder on disk **and** its DB row(s) in `file_manager_items` are removed. It does **not** go to the Recycle Bin and **cannot be undone / restored**. For a folder, all nested files and subfolders are deleted too (`deleted_count` = total rows removed). Permissions on the deleted items are removed by DB cascade.

This is different from the normal delete:

| API | Result |
|---|---|
| `DELETE /files/:id` or `DELETE /folders/:id` | Soft delete → moved to Recycle Bin (restorable) |
| `DELETE /items/:id/permanent?confirm=true` | Hard delete from disk + DB (not restorable), file or folder by id |
| `DELETE /recycle-bin/:id` | Permanent delete only for an item already in the Recycle Bin |

**Confirmation (required):** pass `?confirm=true` in the query string (or JSON body `{ "confirm": true }`). Without it the API returns `400` and nothing is deleted.

**Path parameters:**

| Parameter | Required | Description |
|---|---:|---|
| `id` | Yes | Numeric `file_manager_items.id` or `public_id` of the file **or** folder. Behavior is decided by the item's `item_type`. |

**Headers:** `Authorization: Bearer <token>` (same as other File Manager APIs).

**Access:** Admin, the item owner, or a user with `owner`/`editor` share role on the item / project / FY folder (`canAccessItemForWrite`). `viewer` cannot delete.

**Guards:**

- Personal **user root folder** (`parent_id = null`) cannot be permanently deleted → `400`.
- The **Recycle Bin** folder itself cannot be permanently deleted with this API → `400`.
- An item already in the Recycle Bin can also be permanently deleted with this API (its `recycle_path` file is removed).

**Request example (file id or folder id — same API):**

```http
DELETE /api/file-manager/items/201/permanent?confirm=true HTTP/1.1
Authorization: Bearer <token>
```

**Success (`200 OK`):**

```json
{
  "success": true,
  "message": "File permanently deleted",
  "data": {
    "deleted_count": 1,
    "id": 201,
    "public_id": "1n7Eiy0YN-hERtdvu9Xecf",
    "name": "3d-select.jpg",
    "item_type": "file"
  }
}
```

Folder success is the same shape with `"message": "Folder permanently deleted"` and `deleted_count` counting the folder plus every descendant row removed.

**Failed responses:**

- `400`: `Permanent delete is irreversible. Pass ?confirm=true to continue`, or root / Recycle Bin guard.
- `401`: Not authenticated.
- `403`: No write access to the item.
- `404`: `Item not found` (missing / invalid id).
- `500`: Disk or DB failure.

**Frontend note:** after a successful response, remove the item from the local list / refetch the parent folder children — the item will no longer appear because its DB row and disk file are gone (no page refresh needed if the list state is updated).

---

## 12B. Replace File or Folder (common, by id)

**API name:** Replace file / folder  
**Method:** `POST /api/file-manager/items/:id/replace`

One common API for both — the server detects `item_type` from the `id`:

| `id` points to | Behavior |
|---|---|
| **File** | Send **one** file (field `file` or `files`). Old physical file is deleted and the new file is stored in the same parent folder. The same DB row/id is updated (`name`, `storage_name`, `relative_path`, `mime_type`, `extension`, `size`), so listings immediately display the new file in place of the old one. Google/cloud files cannot be replaced with a local file (`400`). Optional body `name` renames the file. |
| **Folder** | Send the new folder's files (field `file`/`files`, many allowed) with `paths` (JSON string or array of relative paths inside the folder, e.g. `["sub/a.pdf","b.jpg"]`) and optional `folder_name` (wrapper prefix stripped from `paths`). **All old folder contents are deleted first** (physical files + descendant DB rows); the folder row/id, parent and permissions are kept, then the new files/subfolders are created under it — so the listing shows the new folder contents in place of the old. Optional body `name` also renames the folder itself. |

**Content-Type:** `multipart/form-data`

**Success (`200 OK`):**

- File: `{ "success": true, "message": "File replaced successfully", "data": { ...updated file } }`
- Folder: `{ "success": true, "message": "Folder replaced successfully", "data": { "item": { ...folder }, "uploaded": [...], "folders_created": [...], "skipped": [], "errors": [], "counts": { "deleted_old": 4, "uploaded": 3, "folders_created": 1, "skipped": 0, "errors": 0, "total_files": 3 } } }`

**Failed responses:** `400` (no file / `paths` length mismatch), `401`, `403`, `404`, `409` (same name already exists beside the replaced item), `500`. Note: folder replace deletes the old contents before uploading the new files, so if every new file fails the folder is left empty.

---

## 13. List Items

**API name:** List items  
**Method:** `GET /items`  
**Description:** Lists items for the **current `FILEMANAGER_PATH` only**. Syncs from disk before listing.

**Query parameters:**

| Parameter | Required | Description |
|---|---:|---|
| `parent_id` | No | Folder ID, or `null` / empty for top-level roots. |
| `item_type` | No | `folder` or `file`. |

**Defaults:**

| Caller | No `parent_id` provided |
|---|---|
| Admin | All user **root** folders under `FILEMANAGER_PATH` (`parent_id = null`) |
| Non-admin | Children of the user's own root |

**Success (`200 OK`):**

```json
{
  "success": true,
  "data": [ { "id": 14, "name": "RRK", "item_type": "folder", "parent_id": null } ],
  "filemanager_path": "D:/NASTEST",
  "is_admin": true
}
```

**Failed responses:** `400 Invalid parent_id`, `401`, `403`, `404`, `500`.

---

## 14. Search Items

**API name:** Search files and folders  
**Method:** `GET /search`  
**Description:** Searches by name / relative path / extension within the current `FILEMANAGER_PATH`. Admin searches all owners; non-admin searches own items only.

**Query parameters:**

| Parameter | Required | Description |
|---|---:|---|
| `q` or `query` | Yes | Search text. Prefer `q`. |
| `item_type` | No | `folder` or `file`. |
| `limit` | No | Max results (clamped by server, default 100). |

**Success (`200 OK`):**

```json
{
  "success": true,
  "data": [ { "id": 201, "name": "3d-select.jpg", "item_type": "file" } ],
  "filemanager_path": "D:/NASTEST",
  "is_admin": false
}
```

**Failed responses:** `400 Search query (q) is required`, `401`, `500`.

---

## 15. Move Item

**API name:** Move file or folder  
**Method:** `POST /move`  
**Description:** Moves an accessible file or non-root folder into another accessible folder. Updates disk path and `relative_path`. When moved across owners (admin), `owner_id` / `username` follow the **target** folder.

**Body:** JSON (`application/json`), `x-www-form-urlencoded`, or **multipart form-data** (Postman form-data is supported).

```json
{
  "item_id": 201,
  "target_parent_id": 20
}
```

Aliases: `id` → `item_id`, `parent_id` → `target_parent_id`.

Postman form-data example: `id=314`, `target_parent_id=277`.

**Success (`200 OK`):** `{ "success": true, "data": { ...moved item } }`  
Already in target: still `200` with `message: "Already in target folder"`.

**Failed responses:**

- `400`: Missing ids, cannot move root, cannot move into itself/descendant.
- `401` / `403` / `404`
- `409`: Name already exists in the **target** folder (same username + current path).
- `500`

---

## 16. Item permissions (role-based)

Any `file_manager_items` row (folder or file; personal / FY / project) uses **roles** stored in `file_manager_permissions`:

| Role | Access |
|---|---|
| `owner` | Full control |
| `editor` | View + edit / create / rename |
| `viewer` | View / browse only |

There are **no** `can_view` / `can_create` / `can_edit` / `can_rename` / `can_delete` / `can_download` flags.

### Child sharing — `is_childshare`

| Value | Behavior |
|---|---|
| `true` (default) | Share this item **and all child** folders/files (cascaded rows use `inherited_from_item_id`) |
| `false` | Share **this item only** — children are not shared |

Full details: [folderPermissions.md](./folderPermissions.md).

### Preferred routes — `/api/file-manager/permissions`

| Action | Method | Example |
|---|---|---|
| List users | `GET` | `/api/file-manager/permissions?item_id=3096` |
| Check access | `GET` | `/api/file-manager/permissions/access?item_id=3096&user_id=18` |
| Create / upsert | `POST` | body `{ "item_id": 3096, "user_id": 18, "username": "TMM", "role": "viewer", "is_childshare": true }` |
| Update | `PUT` | `/api/file-manager/permissions/3096` body `{ "user_id": 18, "username": "TMM", "role": "editor", "is_childshare": false }` |
| Remove | `DELETE` | `/api/file-manager/permissions?item_id=3096&user_id=18` |

### Owned vs Shared with me

| Surface | Endpoint | Content |
|---|---|---|
| My Folder (owned) | `GET /folders/:id/children` | Items you own |
| Shared with me | `GET /shared-with-me` | Direct shares only (`inherited_from_item_id` null); cascaded children open under the shared parent |

| Action | Method | URL |
|---|---|---|
| List shared roots | `GET` | `/api/file-manager/shared-with-me?page=1&limit=48` (paginated) |
| Browse children | `GET` | `/api/file-manager/shared-with-me/folders/{folderId}/children?page=1&limit=48` (paginated) |

### Folder ZIP download (any scope)

| Action | Method | URL |
|---|---|---|
| Download folder as ZIP | `GET` | `/api/file-manager/folders/{id}/download` |

Works for personal, project, and FY folders. Requires ownership or a share role on the item / ancestor.

Related:

- [folderPermissions.md](./folderPermissions.md)
- [financialYearFileManager.md](./financialYearFileManager.md)
- [projectFilemanager.md](./projectFilemanager.md)

---

## Frontend flow (recommended)

1. `GET /my-folder` — if `exists: false`, show **Create my folder**.
2. User confirms → `POST /my-folder` (handle `201` or `409`).
3. Admin home: `GET /items?parent_id=null` (all roots under `FILEMANAGER_PATH`).
4. User home: open own root, then `GET /folders/:id/children` for navigation.
5. Upload / create / rename / delete / move as needed.
6. Deleted items → `GET /recycle-bin`; restore with `POST /recycle-bin/:id/restore`; permanent remove with `DELETE /recycle-bin/:id`. To skip the Recycle Bin entirely, use the common `DELETE /items/:id/permanent?confirm=true` (file or folder by id — see **12A**). Replace in place with the common `POST /items/:id/replace` (see **12B**).
7. Share an item → `POST /api/file-manager/permissions` with `role` and optional `is_childshare` (`true` = include children, `false` = this item only).
8. Shared items → `GET /shared-with-me`, then `GET /shared-with-me/folders/{id}/children`.

## Duplicate rules (summary)

A create/upload/rename/move is blocked with `409` only when **all** of these match an existing non-deleted row:

1. Same `parent_id`
2. Same `username` (case-insensitive)
3. Same `name` (case-insensitive)
4. Same `filemanager_path` as current `.env` `FILEMANAGER_PATH`

Different storage path or different parent → **allowed**.
