# Project File Manager API

Base URL: `/api/project-file-manager`

All endpoints return JSON responses.

---

## Table of Contents

- [Overview & Architecture](#overview--architecture)
- [Database Schema & Relationships](#database-schema--relationships)
- [Authentication and Headers](#authentication-and-headers)
- [Common Response Formats](#common-response-formats)
- [Folder Provisioning Modes](#folder-provisioning-modes)
- [Permission System (RBAC)](#permission-system-rbac)
- [Folder Management Endpoints](#folder-management-endpoints)
  - [1. List All Project Folders](#1-list-all-project-folders)
  - [2. List My Accessible Project Folders](#2-list-my-accessible-project-folders)
  - [2b. Shared with me](#shared-with-me)
  - [2c. Shared with me — children](#shared-with-me--children-open-folder)
  - [3. Get Project Folder by Project ID](#3-get-project-folder-by-project-id)
  - [4. Get Project Folder by ID](#4-get-project-folder-by-id)
  - [5. Create Project Folder](#5-create-project-folder)
  - [6. Update Project Folder](#6-update-project-folder)
  - [7. Delete Project Folder Mapping](#7-delete-project-folder-mapping)
- [User Permissions Endpoints](#user-permissions-endpoints)
  - [8. List Assigned Users](#8-list-assigned-users)
  - [9. Assign Users & Permissions](#9-assign-users--permissions)
  - [10. Update User Permissions](#10-update-user-permissions)
  - [11. Remove User from Project Folder](#11-remove-user-from-project-folder)
  - [12. Check User Access Permissions](#12-check-user-access-permissions)
- [Permissions API](#permissions-api)
- [Related documentation](#related-documentation)
- [Integration Workflow Examples](#integration-workflow-examples)

---

## Overview & Architecture

The **Project File Manager API** bridges the ERP project sheets (`projects` table) with the File Manager document storage system (`file_manager_items`). It allows each project to possess a dedicated file manager directory on the physical storage (NAS or local storage root), while enforcing fine-grained user permissions per project folder.

### Key Capabilities

| Capability | Details |
|---|---|
| **Project-to-Storage Mapping** | Maps ERP `project_id`, `project_code`, and `financial_year` directly to a physical `file_manager_items` directory. |
| **Project Google Drive Placement** | Creates one Google Drive folder per project. Category and PCB subfolders remain in the ERP File Manager; Google Docs and Sheets are stored in the project root Drive folder. `GOOGLE_DRIVE_FOLDER_ID` is only the grouping parent used to create project roots. |
| **Dual Provisioning Modes** | Can link an existing File Manager directory or automatically provision new physical folders on disk under the user's root or a specified parent directory. |
| **Role-based Access Control** | Per-user `role`: `owner` \| `editor` \| `viewer` on `file_manager_permissions`. |
| **Automatic roles on create** | Settings owners → `owner`; creating user → `editor`; assign users → `editor` (`is_childshare: true`). |
| **Safe Lifecycle Management** | Deleting a project folder mapping removes permissions and association records via database cascading, but preserves the physical files and directories in File Manager. |

---

## Database Schema & Relationships

The project file manager module utilizes two primary database tables defined in `initializeProjectFileManagerTables()`:

```
┌─────────────────────────────────┐           ┌──────────────────────────────────────┐
│  project_file_manager_folders   │ 1       N │ project_file_manager_folder_users    │
├─────────────────────────────────┤───────────┼──────────────────────────────────────┤
│ id (PK)                         │           │ id (PK)                              │
│ project_id (UNIQUE)             │           │ project_folder_id (FK -> folders.id) │
│ project_code                    │           │ user_id                              │
│ financial_year                  │           │ username                             │
│ file_manager_folder_id (FK)     │           │ role (owner\|editor\|viewer)         │
│ created_at / updated_at         │           │ assigned_by_username                 │
└─────────────────────────────────┘           │ assigned_at                          │
                 │ 1                          └──────────────────────────────────────┘
                 ▼ 1
┌─────────────────────────────────┐
│       file_manager_items        │
├─────────────────────────────────┤
│ id (PK)                         │
│ public_id (unique URL id)       │
│ name, relative_path, username   │
│ item_type = 'folder'            │
└─────────────────────────────────┘
```

### 1. Table: `project_file_manager_folders`

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | `BIGSERIAL` | `PRIMARY KEY` | Unique ID of the project folder mapping |
| `project_id` | `BIGINT` | `NOT NULL`, `UNIQUE` | Foreign reference to the ERP project |
| `project_code` | `VARCHAR(100)` | `NOT NULL` | Project identifier code (e.g. `"PRJ-2024-001"`) |
| `financial_year` | `VARCHAR(20)` | `NOT NULL` | Financial year code (e.g. `"2024-2025"`) |
| `file_manager_folder_id` | `BIGINT` | `NOT NULL`, `UNIQUE`, `FK -> file_manager_items(id) ON DELETE CASCADE` | Associated folder in the File Manager storage |
| `created_at` | `TIMESTAMP` | `DEFAULT CURRENT_TIMESTAMP` | Creation timestamp |
| `updated_at` | `TIMESTAMP` | `DEFAULT CURRENT_TIMESTAMP` | Last updated timestamp |

*Joined fields returned from `file_manager_items`:*
- `folder_name` (`name`)
- `folder_relative_path` (`relative_path`)
- `folder_owner_username` (`username`)
- `folder_owner_id` (`owner_id`)
- `folder_is_deleted` (`is_deleted`)

### 2. Table: `file_manager_permissions` (unified)

Project (and FY / personal) shares use the unified permissions table.

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | `BIGSERIAL` | `PRIMARY KEY` | Assignment record ID |
| `item_id` | `BIGINT` | `NOT NULL`, `FK -> file_manager_items(id) ON DELETE CASCADE` | Folder/file item id |
| `user_id` | `BIGINT` | `NOT NULL` | Assigned user id |
| `username` | `VARCHAR(100)` | `NOT NULL` | Assigned username |
| `role` | `VARCHAR(20)` | `NOT NULL`, `owner` \| `editor` \| `viewer` | Access role |
| `assigned_by_username` | `VARCHAR(100)` | `NOT NULL` | Who assigned the role |
| `assigned_at` | `TIMESTAMP` | `DEFAULT CURRENT_TIMESTAMP` | Assignment timestamp |
| `inherited_from_item_id` | `BIGINT` | `NULL`, `FK -> file_manager_items(id)` | Set when cascaded from a parent share; `NULL` = direct share |
| `is_childshare` | `BOOLEAN` | `NOT NULL DEFAULT TRUE` | Direct share: `true` = all children shared; `false` = this item only |

*Constraints & Indexes:*
- `UNIQUE (item_id, user_id)`
- Indexes on `item_id`, `user_id`, `LOWER(username)`, `LOWER(role)`, `inherited_from_item_id`

See [folderPermissions.md](./folderPermissions.md) for `is_childshare` cascade rules.

---

## Authentication and Headers

All endpoints resolve the authenticated actor using JWT token data or fallback development headers:

| Header | Required | Description |
|---|---|---|
| `Authorization: Bearer <token>` | Preferred | JWT containing `id`, `username`, and `access` |
| `x-user-id` | Fallback | User numeric identifier |
| `x-username` | Fallback | Username for audit and ownership tracking |
| `Content-Type: application/json` | For JSON | Required for `POST` and `PUT` bodies |

Requests requiring actor resolution (such as `/my-access`, `POST /`, and `POST /:id/users`) return `401 Unauthorized` if no identity is present.

---

## Common Response Formats

### Success Response

```json
{
  "success": true,
  "data": {}
}
```

### Action Success Response

```json
{
  "success": true,
  "message": "Project file manager folder created",
  "data": {}
}
```

### Error Response

```json
{
  "success": false,
  "message": "project_id, project_code and financial_year are required"
}
```

---

## Folder Provisioning Modes

When calling `POST /api/project-file-manager`, two operational modes are supported:

### Mode 1: Link Existing File Manager Folder
Provide `file_manager_folder_id`:
1. Validates that the folder exists and is of type `folder`.
2. Validates that the folder is not already associated with another project (returns `409 Conflict` if occupied).
3. Links the folder directly to the ERP project.

### Mode 2: Auto-Provision New Folder on Disk
Omit `file_manager_folder_id`:
1. Generates folder name using `folder_name` or defaults to `${project_code} (${financial_year})`.
2. Locates target parent folder:
   - Uses `parent_id` if provided.
   - If `parent_id` is omitted, automatically finds the user's personal root folder via `POST /api/file-manager/my-folder`.
3. Ensures directory exists physically on disk under `FILEMANAGER_PATH`.
4. Creates a new record in `file_manager_items`.
5. Links the newly created directory to the project.

---

## Permission System (roles)

Each assigned user has exactly one **role**:

| Role | Access |
|---|---|
| `owner` | Full control (manage access, edit, delete) |
| `editor` | View + edit / create / rename |
| `viewer` | View / browse only |

There are **no** `can_view` / `can_create` / `can_edit` / `can_rename` / `can_delete` / `can_download` flags.

### Automatic roles on project / PCB create

| Who | Role |
|---|---|
| File Manager Settings owners | `owner` |
| Creating user (authenticated actor) | `editor` (kept as `owner` if they are a settings owner) |
| Assign users in payload | `editor` + `is_childshare: true` (never downgrades `owner`) |

Roles are written to every created project root / structure / PCB folder via `file_manager_permissions`.

Full reference: [folderPermissions.md](./folderPermissions.md).

---

## Folder Management Endpoints

### 1. List All Project Folders

**API name:** List project folders  
**Method:** `GET /api/project-file-manager`  
**Description:** Retrieves all project folder mappings with joined File Manager folder metadata.

#### Query Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `financial_year` (or `financialYear`) | `string` | No | Filter by exact financial year code (e.g. `"2024-2025"`) |
| `search` (or `q`) | `string` | No | Case-insensitive substring search matching `project_code` |

#### Request Example

```http
GET /api/project-file-manager?financial_year=2024-2025&search=PRJ HTTP/1.1
Authorization: Bearer <token>
```

#### Success Response (`200 OK`)

```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "project_id": 105,
      "project_code": "PRJ-2024-001",
      "financial_year": "2024-2025",
      "file_manager_folder_id": 84,
      "created_at": "2026-09-15T08:30:00.000Z",
      "updated_at": "2026-09-15T08:30:00.000Z",
      "folder_name": "PRJ-2024-001 (2024-2025)",
      "folder_relative_path": "AAM/Projects/PRJ-2024-001 (2024-2025)",
      "folder_owner_username": "AAM",
      "folder_owner_id": 3,
      "folder_is_deleted": false
    }
  ]
}
```

---

### 2. List My Accessible Project Folders

**API name:** List user accessible project folders  
**Method:** `GET /api/project-file-manager/my-access`  
**Description:** Retrieves all project folders where the authenticated user has an assigned role (`owner` \| `editor` \| `viewer`).

#### Request Example

```http
GET /api/project-file-manager/my-access HTTP/1.1
Authorization: Bearer <token>
```

#### Success Response (`200 OK`)

```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "project_id": 105,
      "project_code": "PRJ-2024-001",
      "financial_year": "2024-2025",
      "created_at": "2026-09-15T08:30:00.000Z",
      "updated_at": "2026-09-15T08:30:00.000Z",
      "role": "editor",
      "assigned_at": "2026-09-15T08:35:00.000Z",
      "folder_name": "PRJ-2024-001 (2024-2025)",
      "folder_relative_path": "AAM/Projects/PRJ-2024-001 (2024-2025)"
    }
  ]
}
```

#### Error Response (`401 Unauthorized`)

```json
{
  "success": false,
  "message": "Unauthorized"
}
```

---

### Shared with me

**API name:** Shared with me (project + financial year + personal)  
**Method:** `GET /api/file-manager/shared-with-me`  
**Description:** Returns **direct shared roots only** (Google Drive–style):

1. List roots here (`inherited_from_item_id IS NULL` — cascaded children do **not** appear as roots)
2. If a parent FY/folder is already shared with you, nested projects under it are **not** duplicated at root — open them via children
3. Open a folder → `GET /api/file-manager/shared-with-me/folders/{folderId}/children`
4. Nested folders use each child’s `children_api`

Owned folders stay on My Folder / `GET /file-manager/folders/:id/children`.

Any assigned role (`owner` \| `editor` \| `viewer`) is returned from the permission row (`is_owner` only when `role === owner`). Sorted by newest `assigned_at` first.

| Share type | Open children |
|---|---|
| `project` | `GET /api/file-manager/shared-with-me/folders/{folderId}/children` (nested id = child folder id) |
| `financial_year` | Same children URL; children are project folders with real DB `id` / `parent_id` |
| `file_manager` | Personal shared folder children |

#### Query parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `username` | `string` | No | Shared-to username (default: logged-in user). Non-admins may only query themselves. |
| `user_id` | `number` | No | Shared-to user id (combined with username when both set) |
| `assigned_by` / `shared_by` | `string` | No | Filter by who shared (`assigned_by_username`) |
| `project_code` | `string` | No | Exact project code (project shares) |
| `financial_year` / `year_code` | `string` | No | FY filter (project + FY shares) |
| `search` / `q` | `string` | No | Search project/folder/year/shared-by |
| `include_owned` | `boolean` | No | `1` / `true` to include folders the user owns (project shares) |
| `type` / `share_type` | `string` | No | `project` \| `financial_year` \| `fy` \| `year` |
| `page` | `number` | No | 1-based page (default `1`) |
| `limit` | `number` | No | Page size (default `48`, max `200`) |

#### Request Example

```http
GET /api/file-manager/shared-with-me HTTP/1.1
Authorization: Bearer <token>
```

#### Success Response (`200 OK`) — root folders only

```json
{
  "success": true,
  "message": "Shared with me folders",
  "meta": {
    "username": "john",
    "user_id": 45,
    "count": 2,
    "project_count": 1,
    "financial_year_count": 1,
    "include_owned": false,
    "browse": {
      "root": "/api/file-manager/shared-with-me",
      "children": "/api/file-manager/shared-with-me/folders/{folderId}/children",
      "note": "Open a shared folder via /file-manager/shared-with-me/folders/{folderId}/children"
    }
  },
  "pagination": {
    "page": 1,
    "limit": 48,
    "total": 2,
    "total_pages": 1,
    "has_more": false,
    "offset": 0
  },
  "data": [
    {
      "id": 12,
      "public_id": "1n7Eiy0YN-hERtdvu9Xecf",
      "name": "PRJ-2024-001",
      "item_type": "folder",
      "share_type": "project",
      "project_code": "PRJ-2024-001",
      "role": "viewer",
      "assigned_by_username": "admin",
      "assigned_at": "2026-10-05T06:00:00.000Z",
      "is_owner": false,
      "children_api": "/api/file-manager/shared-with-me/folders/12/children",
      "access": { "role": "viewer", "is_owner": false, "can_manage_access": false }
    },
    {
      "id": 3,
      "public_id": "aB3xK9mPqR2sT7uVwXyZ0",
      "name": "2025-2026",
      "item_type": "folder",
      "share_type": "financial_year",
      "year_code": "2025-2026",
      "role": "owner",
      "assigned_by_username": "system",
      "is_owner": true,
      "children_api": "/api/file-manager/shared-with-me/folders/3/children",
      "access": { "role": "owner", "is_owner": true, "can_manage_access": true }
    }
  ]
}
```

---

### Shared with me — children (open folder)

**API name:** Shared folder children  
**Method:** `GET /api/file-manager/shared-with-me/folders/:folderId/children`  
**Description:** Lists children of a shared project/FY root or nested project folder. Requires an assigned role on that share.

#### Path parameters

| Parameter | Description |
|---|---|
| `folderId` | Shared root id, or nested project folder item id |

#### Query parameters

| Parameter | For | Description |
|---|---|---|
| `parent_id` | project root | Optional nested parent when `folderId` is the project root |
| `path` | financial_year | Relative path under the FY root |
| `page` | all | 1-based page (default `1`) |
| `limit` | all | Page size (default `48`, max `200`) |

#### Open shared folder

```http
GET /api/file-manager/shared-with-me/folders/12/children?page=1&limit=48 HTTP/1.1
Authorization: Bearer <token>
```

```json
{
  "success": true,
  "share_type": "project",
  "folder_id": 12,
  "parent_id": null,
  "pagination": {
    "page": 1,
    "limit": 48,
    "total": 12,
    "total_pages": 1,
    "has_more": false,
    "offset": 0
  },
  "folder": {
    "id": 12,
    "name": "PRJ-2024-001",
    "relative_path": "2025-2026/PRJ-2024-001"
  },
  "permissions": {
    "role": "viewer",
    "is_owner": false,
    "can_manage_access": false
  },
  "access": {
    "role": "viewer",
    "is_owner": false,
    "can_manage_access": false
  },
  "data": [
    {
      "id": 501,
      "public_id": "Zk9mPqR2sT7uVwXyZ0aB3",
      "name": "PRJ-2024-001_TO_CLIENT",
      "item_type": "folder",
      "share_type": "project",
      "project_folder_id": 12,
      "role": "viewer",
      "children_api": "/api/file-manager/shared-with-me/folders/501/children",
      "access": { "role": "viewer", "is_owner": false, "can_manage_access": false }
    }
  ]
}
```

#### Open nested project folder

```http
GET /api/file-manager/shared-with-me/folders/501/children HTTP/1.1
Authorization: Bearer <token>
```

#### Open FY share root / nested path

```http
GET /api/file-manager/shared-with-me/folders/3/children HTTP/1.1
Authorization: Bearer <token>
```

```http
GET /api/file-manager/shared-with-me/folders/3/children?path=PRJ-2024-001 HTTP/1.1
Authorization: Bearer <token>
```

#### Frontend browse flow

```text
GET /api/file-manager/shared-with-me
  → show data[] as root folders
  → user opens row
GET row.children_api
  → show data[] as children
```

#### Notes

- Prefer `POST /api/file-manager/permissions` with `role` for sharing any item.
- Assign FY access via `POST /api/financial-year-file-manager/:id/users` with `role`, or `POST /api/file-manager/permissions` with the FY folder `item_id` and `role`.
- File Manager Settings owners are auto-granted `owner` on FY folders (see [financialYearFileManager.md](./financialYearFileManager.md)).

#### Errors

- `401` — unauthorized
- `403` — no access to that share / non-admin querying another username
- `404` — shared folder or nested item not found
- `400` — invalid path / parent is a file

---

### 3. Get Project Folder by Project ID

**API name:** Get project folder by project ID  
**Method:** `GET /api/project-file-manager/project/:projectId`  
**Description:** Retrieves a project folder record and its full list of assigned users by the ERP `projectId`.

#### URL Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `projectId` | `number` | Yes | Numeric ERP Project ID (> 0) |

#### Request Example

```http
GET /api/project-file-manager/project/105 HTTP/1.1
Authorization: Bearer <token>
```

#### Success Response (`200 OK`)

```json
{
  "success": true,
  "data": {
    "id": 1,
    "project_id": 105,
    "project_code": "PRJ-2024-001",
    "financial_year": "2024-2025",
    "file_manager_folder_id": 84,
    "created_at": "2026-09-15T08:30:00.000Z",
    "updated_at": "2026-09-15T08:30:00.000Z",
    "folder_name": "PRJ-2024-001 (2024-2025)",
    "folder_relative_path": "AAM/Projects/PRJ-2024-001 (2024-2025)",
    "folder_owner_username": "AAM",
    "folder_owner_id": 3,
    "folder_is_deleted": false,
    "users": [
      {
        "id": 1,
        "item_id": 1,
        "user_id": 3,
        "username": "AAM",
        "role": "owner",
        "assigned_by_username": "AAM",
        "assigned_at": "2026-09-15T08:30:00.000Z",
        "is_owner": true,
        "can_manage_access": true,
        "access": { "role": "owner", "is_owner": true, "can_manage_access": true }
      },
      {
        "id": 2,
        "item_id": 1,
        "user_id": 7,
        "username": "TMM",
        "role": "viewer",
        "assigned_by_username": "AAM",
        "assigned_at": "2026-09-15T08:35:00.000Z",
        "is_owner": false,
        "can_manage_access": false,
        "access": { "role": "viewer", "is_owner": false, "can_manage_access": false }
      }
    ]
  }
}
```

#### Error Responses

- **`400 Bad Request`**:
  ```json
  {
    "success": false,
    "message": "Valid projectId is required"
  }
  ```
- **`404 Not Found`**:
  ```json
  {
    "success": false,
    "message": "Project file manager folder not found"
  }
  ```

---

### 4. Get Project Folder by ID

**API name:** Get project folder by mapping ID  
**Method:** `GET /api/project-file-manager/:id`  
**Description:** Retrieves a project folder mapping and assigned users by the mapping's primary key `id`.

#### URL Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | `number` | Yes | Project folder mapping ID (> 0) |

#### Request Example

```http
GET /api/project-file-manager/1 HTTP/1.1
Authorization: Bearer <token>
```

#### Success Response (`200 OK`)

Response matches the shape of endpoint 3 (folder metadata object with embedded `users: [...]`).

---

### 5. Create Project Folder

**API name:** Create project file manager folder  
**Method:** `POST /api/project-file-manager`  
**Description:** Provisions a project folder. Links an existing File Manager directory or creates a new physical directory under `FILEMANAGER_PATH`. Automatically assigns creator with full permissions and accepts initial user permissions.

#### Request Body Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `project_id` (or `projectId`) | `number` | **Yes** | ERP project primary key ID |
| `project_code` (or `projectCode`) | `string` | **Yes** | Project code |
| `financial_year` (or `financialYear`) | `string` | **Yes** | Financial year identifier (e.g. `"2024-2025"`) |
| `file_manager_folder_id` (or `fileManagerFolderId`) | `number` | No | ID of existing File Manager folder to link. If omitted, a folder is auto-created. |
| `parent_id` (or `parentId`) | `number` | No | Parent folder ID in File Manager when auto-creating (defaults to user's root folder) |
| `folder_name` (or `folderName`) | `string` | No | Custom folder name (defaults to `${projectCode} (${financialYear})`) |
| `users` | `array` | No | List of user permission objects to assign immediately |

#### User Object in `users` Array (assign users → role `editor`, `is_childshare: true`)

```json
{
  "user_id": 7,
  "username": "TMM"
}
```

On create, settings owners get `owner`, the creating user gets `editor`, and assign users get `editor` — all with `is_childshare: true`.

#### Request Example (Auto-creating folder)

```http
POST /api/project-file-manager HTTP/1.1
Content-Type: application/json
Authorization: Bearer <token>

{
  "project_id": 105,
  "project_code": "PRJ-2024-001",
  "financial_year": "2024-2025",
  "users": [
    {
      "user_id": 7,
      "username": "TMM",
      "can_view": true,
      "can_create": false,
      "can_download": true
    }
  ]
}
```

#### Success Response (`201 Created`)

```json
{
  "success": true,
  "message": "Project file manager folder created",
  "data": {
    "id": 1,
    "project_id": 105,
    "project_code": "PRJ-2024-001",
    "financial_year": "2024-2025",
    "file_manager_folder_id": 84,
    "created_at": "2026-09-15T08:30:00.000Z",
    "updated_at": "2026-09-15T08:30:00.000Z",
    "folder_name": "PRJ-2024-001 (2024-2025)",
    "folder_relative_path": "AAM/PRJ-2024-001 (2024-2025)",
    "folder_owner_username": "AAM",
    "folder_owner_id": 3,
    "folder_is_deleted": false,
    "users": [
      {
        "id": 1,
        "item_id": 1,
        "user_id": 3,
        "username": "AAM",
        "role": "owner",
        "assigned_by_username": "AAM",
        "assigned_at": "2026-09-15T08:30:00.000Z",
        "is_owner": true,
        "can_manage_access": true,
        "access": { "role": "owner", "is_owner": true, "can_manage_access": true }
      },
      {
        "id": 2,
        "item_id": 1,
        "user_id": 7,
        "username": "TMM",
        "role": "viewer",
        "assigned_by_username": "AAM",
        "assigned_at": "2026-09-15T08:30:00.000Z",
        "is_owner": false,
        "can_manage_access": false,
        "access": { "role": "viewer", "is_owner": false, "can_manage_access": false }
      }
    ]
  }
}
```

#### Error Responses

- **`400 Bad Request`**: Missing required parameters, or personal root folder is not yet initialized.
  ```json
  {
    "success": false,
    "message": "User root folder not found. Call POST /api/file-manager/my-folder first."
  }
  ```
- **`409 Conflict`**: Project already has an assigned folder, or the File Manager folder is already linked.
  ```json
  {
    "success": false,
    "message": "A file manager folder already exists for this project"
  }
  ```

---

### 6. Update Project Folder

**API name:** Update project file manager folder  
**Method:** `PUT /api/project-file-manager/:id`  
**Description:** Updates the project code, financial year, or switches the mapped `file_manager_folder_id`.

#### URL Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | `number` | Yes | Project folder mapping ID (> 0) |

#### Request Body Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `project_code` (or `projectCode`) | `string` | No | Updated project code |
| `financial_year` (or `financialYear`) | `string` | No | Updated financial year |
| `file_manager_folder_id` (or `fileManagerFolderId`) | `number` | No | Link to a different File Manager folder |

#### Request Example

```http
PUT /api/project-file-manager/1 HTTP/1.1
Content-Type: application/json
Authorization: Bearer <token>

{
  "financial_year": "2025-2026"
}
```

#### Success Response (`200 OK`)

```json
{
  "success": true,
  "message": "Project file manager folder updated",
  "data": {
    "id": 1,
    "project_id": 105,
    "project_code": "PRJ-2024-001",
    "financial_year": "2025-2026",
    "file_manager_folder_id": 84,
    "created_at": "2026-09-15T08:30:00.000Z",
    "updated_at": "2026-10-02T11:00:00.000Z",
    "users": [ ... ]
  }
}
```

#### Error Responses

- **`404 Not Found`**: If the mapping ID or the specified `file_manager_folder_id` does not exist.
- **`409 Conflict`**: If the target `file_manager_folder_id` is already mapped to a different project.

---

### 7. Delete Project Folder Mapping

**API name:** Delete project folder mapping  
**Method:** `DELETE /api/project-file-manager/:id`  
**Description:** Removes the project-to-folder mapping and cascades user permission records.

> [!NOTE]
> This endpoint only removes the ERP association and permissions from the database. The actual directory and its files in the File Manager (`file_manager_items`) and on physical disk remain intact.

#### URL Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | `number` | Yes | Project folder mapping ID (> 0) |

#### Request Example

```http
DELETE /api/project-file-manager/1 HTTP/1.1
Authorization: Bearer <token>
```

#### Success Response (`200 OK`)

```json
{
  "success": true,
  "message": "Project file manager folder mapping deleted",
  "data": {
    "id": 1,
    "project_id": 105,
    "project_code": "PRJ-2024-001",
    "financial_year": "2025-2026",
    "file_manager_folder_id": 84,
    "created_at": "2026-09-15T08:30:00.000Z",
    "updated_at": "2026-10-02T11:00:00.000Z"
  }
}
```

---

## User Permissions Endpoints

### 8. List Assigned Users

**API name:** List project folder users  
**Method:** `GET /api/project-file-manager/:id/users`  
**Description:** Lists all users assigned to the specified project folder along with their active permissions.

#### URL Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | `number` | Yes | Project folder mapping ID (> 0) |

#### Request Example

```http
GET /api/project-file-manager/1/users HTTP/1.1
Authorization: Bearer <token>
```

#### Success Response (`200 OK`)

```json
{
  "success": true,
  "data": [
    {
        "id": 1,
        "item_id": 1,
        "user_id": 3,
        "username": "AAM",
        "role": "owner",
        "assigned_by_username": "AAM",
        "assigned_at": "2026-09-15T08:30:00.000Z",
        "is_owner": true,
        "can_manage_access": true,
        "access": { "role": "owner", "is_owner": true, "can_manage_access": true }
      },
    {
        "id": 2,
        "item_id": 1,
        "user_id": 7,
        "username": "TMM",
        "role": "viewer",
        "assigned_by_username": "AAM",
        "assigned_at": "2026-09-15T08:35:00.000Z",
        "is_owner": false,
        "can_manage_access": false,
        "access": { "role": "viewer", "is_owner": false, "can_manage_access": false }
      }
  ]
}
```

---

### 9. Assign Users & Permissions

**API name:** Assign users to project folder  
**Method:** `POST /api/project-file-manager/:id/users`  
**Description:** Assigns or updates (upserts) user permissions for a project folder. Accepts either a single user object or a `{ users: [...] }` payload for bulk assignment.

#### URL Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | `number` | Yes | Project folder mapping ID (> 0) |

#### Request Body Fields (per user)

| Field | Type | Required | Description |
|---|---|---|---|
| `user_id` (or `userId`) | `number` | **Yes** | Numeric user ID |
| `username` (or `user_name`) | `string` | **Yes** | Username |
| `can_view` (or `canView`) | `boolean` | No | Defaults to `true` |
| `can_create` (or `canCreate`) | `boolean` | No | Defaults to `false` |
| `can_rename` (or `canRename`) | `boolean` | No | Defaults to `false` |
| `can_delete` (or `canDelete`) | `boolean` | No | Defaults to `false` |
| `can_download` (or `canDownload`) | `boolean` | No | Defaults to `true` |

#### Request Example (Bulk assignment)

```http
POST /api/project-file-manager/1/users HTTP/1.1
Content-Type: application/json
Authorization: Bearer <token>

{
  "users": [
    {
      "user_id": 12,
      "username": "RRK",
      "can_view": true,
      "can_create": true,
      "can_download": true
    },
    {
      "user_id": 15,
      "username": "DEV1",
      "can_view": true,
      "can_create": false,
      "can_download": false
    }
  ]
}
```

#### Success Response (`201 Created`)

```json
{
  "success": true,
  "message": "User permissions saved",
  "data": [
    {
        "id": 3,
        "item_id": 1,
        "user_id": 12,
        "username": "RRK",
        "role": "editor",
        "assigned_by_username": "AAM",
        "assigned_at": "2026-10-02T11:15:00.000Z",
        "is_owner": false,
        "can_manage_access": false,
        "access": { "role": "editor", "is_owner": false, "can_manage_access": false }
      },
    {
        "id": 4,
        "item_id": 1,
        "user_id": 15,
        "username": "DEV1",
        "role": "viewer",
        "assigned_by_username": "AAM",
        "assigned_at": "2026-10-02T11:15:00.000Z",
        "is_owner": false,
        "can_manage_access": false,
        "access": { "role": "viewer", "is_owner": false, "can_manage_access": false }
      }
  ]
}
```

---

### 10. Update User Permissions

**API name:** Update user permissions  
**Method:** `PUT /api/project-file-manager/:id/users/:userId`  
**Description:** Updates permissions for a specific user assigned to the project folder.

#### URL Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | `number` | Yes | Project folder mapping ID (> 0) |
| `userId` | `number` | Yes | Numeric user ID (> 0) |

#### Request Body Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `username` | `string` | No | Optional username update |
| `can_view` | `boolean` | No | Update view permission |
| `can_create` | `boolean` | No | Update upload/create permission |
| `can_rename` | `boolean` | No | Update rename permission |
| `can_delete` | `boolean` | No | Update delete permission |
| `can_download` | `boolean` | No | Update download permission |

#### Request Example

```http
PUT /api/project-file-manager/1/users/12 HTTP/1.1
Content-Type: application/json
Authorization: Bearer <token>

{
  "can_delete": true,
  "can_rename": true
}
```

#### Success Response (`200 OK`)

```json
{
  "success": true,
  "message": "User permissions updated",
  "data": {
        "id": 3,
        "item_id": 1,
        "user_id": 12,
        "username": "RRK",
        "role": "owner",
        "assigned_by_username": "AAM",
        "assigned_at": "2026-10-02T11:20:00.000Z",
        "is_owner": true,
        "can_manage_access": true,
        "access": { "role": "owner", "is_owner": true, "can_manage_access": true }
      }
}
```

#### Error Response (`404 Not Found`)

```json
{
  "success": false,
  "message": "User assignment not found"
}
```

---

### 11. Remove User from Project Folder

**API name:** Remove user assignment  
**Method:** `DELETE /api/project-file-manager/:id/users/:userId`  
**Description:** Revokes all access for a user by deleting their assignment record.

#### URL Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | `number` | Yes | Project folder mapping ID (> 0) |
| `userId` | `number` | Yes | Numeric user ID (> 0) |

#### Request Example

```http
DELETE /api/project-file-manager/1/users/15 HTTP/1.1
Authorization: Bearer <token>
```

#### Success Response (`200 OK`)

```json
{
  "success": true,
  "message": "User removed from project folder",
  "data": {
    "id": 4,
    "project_folder_id": 1,
    "user_id": 15,
    "username": "DEV1"
  }
}
```

---

### 12. Check User Access Permissions

**API name:** Get user access permissions  
**Method:** `GET /api/project-file-manager/:id/access/:userId`  
**Description:** Checks the effective permissions of a specific user for a project folder. If the user is not explicitly assigned, returns a default zero-permission payload (`false` across all flags).

#### URL Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | `number` | Yes | Project folder mapping ID (> 0) |
| `userId` | `number` | Yes | Numeric user ID (> 0) |

#### Request Example

```http
GET /api/project-file-manager/1/access/12 HTTP/1.1
Authorization: Bearer <token>
```

#### Success Response — User Assigned (`200 OK`)

```json
{
  "success": true,
  "data": {
        "id": 3,
        "item_id": 1,
        "user_id": 12,
        "username": "RRK",
        "role": "owner",
        "assigned_by_username": "AAM",
        "assigned_at": "2026-10-02T11:20:00.000Z",
        "is_owner": true,
        "can_manage_access": true,
        "access": { "role": "owner", "is_owner": true, "can_manage_access": true }
      }
}
```

#### Success Response — User Not Assigned (`200 OK`)

```json
{
  "success": true,
  "data": {
    "project_folder_id": 1,
    "user_id": 99,
    "can_view": false,
    "can_create": false,
    "can_rename": false,
    "can_delete": false,
    "can_download": false
  }
}
```

---

## Permissions API

Project folder / file permissions use the single File Manager API (`role` + optional `is_childshare`):

| Action | Endpoint |
|---|---|
| List | `GET /api/file-manager/permissions?item_id=:id` |
| Assign / upsert | `POST /api/file-manager/permissions` body `{ item_id, user_id, username, role, is_childshare? }` |
| Update | `PUT /api/file-manager/permissions/:itemId` body `{ item_id, user_id, username, role, is_childshare? }` |
| Remove | `DELETE /api/file-manager/permissions?item_id=:id&user_id=:userId` |
| Check access | `GET /api/file-manager/permissions/access?item_id=:id&user_id=:userId` |

| `is_childshare` | Effect |
|---|---|
| `true` (default) | Cascade same role to all child folders/files |
| `false` | Share this project folder/file only |

Full reference: [folderPermissions.md](./folderPermissions.md).

Legacy routes in this document (`/:id/users`, `/:id/users/:userId`, `/:id/access/:userId`) remain supported.

### Edit Project — Assign Users

On Save in the Edit Project modal, assigned-user diffs call the permissions API against the project FM folder (`is_childshare: true` for adds). See [folderPermissions.md](./folderPermissions.md#edit-project--assign-users-frontend).

---

## Related documentation

| Doc | Covers |
|---|---|
| [folderPermissions.md](./folderPermissions.md) | `/api/file-manager/permissions` for FM items, FY, project |
| [financialYearFileManager.md](./financialYearFileManager.md) | FY folders, owners, FY permissions |
| [categoriesFolderStructure.md](./categoriesFolderStructure.md) | Category template + `folder_scope` (project / pcb) |
| [filemanagerAPI.md](./filemanagerAPI.md) | Personal NAS file manager (`FILEMANAGER_PATH`) |

---

## Integration Workflow Examples

### Workflow 1: Provision Folder During Project Creation

When a new project is created in the ERP frontend:

```typescript
async function provisionProjectFolder(project: {
  id: number;
  project_code: string;
  financial_year: string;
}) {
  const token = localStorage.getItem('token');

  const res = await fetch('/api/project-file-manager', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      project_id: project.id,
      project_code: project.project_code,
      financial_year: project.financial_year,
    }),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.message || 'Failed to provision folder');
  }

  return data.data; // contains folder mapping and default creator permissions
}
```

### Workflow 2: Enforcing UI Permissions in Project Explorer

When rendering the Project File Manager tab in the UI:

```typescript
interface ProjectFolderPermissions {
  can_view: boolean;
  can_create: boolean;
  can_rename: boolean;
  can_delete: boolean;
  can_download: boolean;
}

function evaluateActionAvailability(permissions: ProjectFolderPermissions) {
  return {
    showUploadButton: permissions.can_create,
    showNewFolderButton: permissions.can_create,
    showRenameOption: permissions.can_rename,
    showDeleteOption: permissions.can_delete,
    showDownloadButton: permissions.can_download,
  };
}
```
