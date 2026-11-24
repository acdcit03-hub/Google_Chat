# Financial Year File Manager API

Base URL: `/api/financial-year-file-manager`

All endpoints return JSON.

Physical root: `PROJECT_FILE_MANAGER_PATH` from `.env` (e.g. `D:\PROJECT_FILES`). Each financial year becomes a top-level folder: `{PROJECT_FILE_MANAGER_PATH}/{year_code}`.

---

## Table of Contents

- [Overview](#overview)
- [Database tables](#database-tables)
- [Owners (File Manager Settings)](#owners-file-manager-settings)
- [Authentication](#authentication)
- [Folder endpoints](#folder-endpoints)
  - [1. List FY folders](#1-list-fy-folders)
  - [2. Sync all FY folders](#2-sync-all-fy-folders)
  - [3. Get by year code](#3-get-by-year-code)
  - [4. Ensure by year code](#4-ensure-by-year-code)
  - [5. Get by financial year id](#5-get-by-financial-year-id)
  - [6. Get by id](#6-get-by-id)
  - [7. List disk children](#7-list-disk-children)
- [User permissions endpoints](#user-permissions-endpoints)
  - [8. List users](#8-list-users)
  - [9. Assign users](#9-assign-users)
  - [10. Update user](#10-update-user)
  - [11. Remove user](#11-remove-user)
  - [12. Check access](#12-check-access)
- [Shared with me](#shared-with-me)
- [Unified permissions API](#unified-permissions-api)

---

## Overview

| Capability | Details |
|---|---|
| FY root folders | One DB row + disk folder per `financial_years.year_code` |
| Project nesting | Project folders are created under `{year_code}/{project_code}` via Project File Manager |
| Permissions | Per-user flags on `financial_year_file_manager_folder_users` |
| Settings owners | Active File Manager Settings owners are auto-applied as FY folder owners (full access) |
| Shared with me | FY folders with `can_view` appear in `GET /api/project-file-manager/shared-with-me` with `share_type: "financial_year"` |

---

## Database tables

### `financial_year_file_manager_folders`

| Column | Type | Notes |
|---|---|---|
| `id` | BIGSERIAL | PK |
| `financial_year_id` | BIGINT | FK → `financial_years.id` (unique) |
| `year_code` | VARCHAR(20) | Unique year code |
| `folder_name` | VARCHAR(100) | Disk folder name |
| `public_id` | VARCHAR(32) | Unique URL-safe id (16-byte base64url) on unified `file_manager_items` |
| `relative_path` | TEXT | Relative to project FM root |
| `absolute_path` | TEXT | Absolute disk path |
| `project_file_manager_path` | TEXT | Root path snapshot |
| `owner_id` | BIGINT | Primary File Manager Settings owner |
| `username` | VARCHAR(100) | Primary owner username |
| `is_folder` | BOOLEAN | Disk folder exists |

### `financial_year_file_manager_folder_users`

| Column | Type | Notes |
|---|---|---|
| `fy_folder_id` | BIGINT | FK → FY folder |
| `user_id` | BIGINT | Unique with `fy_folder_id` |
| `username` | VARCHAR(100) | |
| `can_view` / `can_create` / `can_rename` / `can_delete` / `can_download` | BOOLEAN | RBAC flags |
| `assigned_by_username` | VARCHAR(100) | Who assigned |
| `assigned_at` | TIMESTAMP | |

---

## Owners (File Manager Settings)

Selected owners from `/api/file-manager-settings` are applied to every FY folder:

1. Primary owner (`access=true` preferred, else first active) → `owner_id` / `username` on the FY folder
2. All active settings owners → full permissions in `financial_year_file_manager_folder_users`

Applied when:

- FY folders are ensured / synced (startup, `POST /sync`, `POST /year/:yearCode`)
- An owner is created/updated via File Manager Settings (`POST` / `PUT /api/file-manager-settings`)

---

## Authentication

| Header | Required | Description |
|---|---|---|
| `Authorization: Bearer <token>` | Yes for permission mutate | JWT |
| `Content-Type: application/json` | POST/PUT bodies | |

---

## Folder endpoints

### 1. List FY folders

**Method:** `GET /api/financial-year-file-manager`

```http
GET /api/financial-year-file-manager HTTP/1.1
Authorization: Bearer <token>
```

```json
{
  "success": true,
  "root": "D:/PROJECT_FILES",
  "data": [
    {
      "id": 3,
      "financial_year_id": 7,
      "year_code": "2025-2026",
      "folder_name": "2025-2026",
      "relative_path": "2025-2026",
      "absolute_path": "D:/PROJECT_FILES/2025-2026",
      "owner_id": 12,
      "username": "fmowner",
      "is_folder": true,
      "start_year": 2025,
      "end_year": 2026,
      "is_current": true,
      "is_active": true
    }
  ]
}
```

---

### 2. Sync all FY folders

**Method:** `POST /api/financial-year-file-manager/sync`  
**Description:** Ensures disk folders + DB rows for every `financial_years` row, and applies File Manager Settings owners.

```json
{
  "success": true,
  "data": {
    "root": "D:/PROJECT_FILES",
    "folders": [ { "year_code": "2025-2026", "created": false, "entry": {} } ]
  }
}
```

---

### 3. Get by year code

**Method:** `GET /api/financial-year-file-manager/year/:yearCode`

Includes `users` array.

---

### 4. Ensure by year code

**Method:** `POST /api/financial-year-file-manager/year/:yearCode`  
**Description:** Create/ensure one FY folder on disk + DB + owners.

---

### 5. Get by financial year id

**Method:** `GET /api/financial-year-file-manager/financial-year/:financialYearId`

Includes `users`.

---

### 6. Get by id

**Method:** `GET /api/financial-year-file-manager/:id`

Includes `users`.

---

### 7. List disk children

**Method:** `GET /api/financial-year-file-manager/:id/children`  
**Description:** Lists immediate files/folders on disk under the FY absolute path (project codes, etc.).

```json
{
  "success": true,
  "data": [
    {
      "name": "PRJ-001",
      "item_type": "folder",
      "absolute_path": "D:/PROJECT_FILES/2025-2026/PRJ-001",
      "size": null
    }
  ]
}
```

---

## User permissions endpoints

Same RBAC shape as Project File Manager.

### 8. List users

**Method:** `GET /api/financial-year-file-manager/:id/users`

```http
GET /api/financial-year-file-manager/3/users HTTP/1.1
Authorization: Bearer <token>
```

```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "fy_folder_id": 3,
      "user_id": 45,
      "username": "john",
      "can_view": true,
      "can_create": false,
      "can_rename": false,
      "can_delete": false,
      "can_download": true,
      "assigned_by_username": "admin",
      "assigned_at": "2026-10-05T05:30:00.000Z"
    }
  ]
}
```

---

### 9. Assign users

**Method:** `POST /api/financial-year-file-manager/:id/users`  
**Description:** Upsert one user or `{ "users": [...] }`.

```json
{
  "users": [
    {
      "user_id": 45,
      "username": "john",
      "can_view": true,
      "can_create": false,
      "can_rename": false,
      "can_delete": false,
      "can_download": true
    }
  ]
}
```

Or a single user object at the top level (`user_id`, `username`, `can_*`).

```json
{
  "success": true,
  "message": "Financial year folder permissions saved",
  "data": [ { "...": "permission row" } ]
}
```

---

### 10. Update user

**Method:** `PUT /api/financial-year-file-manager/:id/users/:userId`

```json
{
  "can_create": true,
  "can_rename": true
}
```

```json
{
  "success": true,
  "message": "User permissions updated",
  "data": { "...": "updated row" }
}
```

---

### 11. Remove user

**Method:** `DELETE /api/financial-year-file-manager/:id/users/:userId`

```json
{
  "success": true,
  "message": "User removed from financial year folder",
  "data": { "...": "deleted row" }
}
```

---

### 12. Check access

**Method:** `GET /api/financial-year-file-manager/:id/access/:userId`

Returns the assignment or all-false defaults.

---

## Shared with me

FY folders shared with a user (`can_view = true`) are returned by:

```http
GET /api/project-file-manager/shared-with-me HTTP/1.1
Authorization: Bearer <token>
```

Response rows for FY shares include:

| Field | Value |
|---|---|
| `share_type` | `"financial_year"` |
| `year_code` / `folder_name` | FY identity |
| `can_*` | Permission flags |
| `is_owner` | `true` when `owner_id` matches the shared user |
| `assigned_by_username` | Who shared |

Filter FY only:

```http
GET /api/project-file-manager/shared-with-me?type=financial_year
```

Also accepted: `type=fy` or `type=year`.

See [projectFilemanager.md — Shared with me](./projectFilemanager.md#shared-with-me).

---

## Permissions API

Use the single File Manager permissions API for FY folders / files.

`is_childshare: true` (default) shares the FY folder **and all project children**; `false` shares the FY folder only.

```http
POST /api/file-manager/permissions
Content-Type: application/json

{
  "item_id": 3,
  "user_id": 45,
  "username": "john",
  "role": "viewer",
  "is_childshare": true
}
```

Shared with me lists the FY root when shared directly; projects under it open via children (not duplicated at root when the FY is already shared).

Full reference: [folderPermissions.md](./folderPermissions.md).
