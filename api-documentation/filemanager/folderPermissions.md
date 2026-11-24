# File Manager Permissions (Role-Based)

**One API** for folders and files: `/api/file-manager/permissions` (`fileManagerpermission.controller.js` + `fileManagerPermission.model.js`).

Permissions are **role-based**. There are no `can_view` / `can_create` / `can_edit` / `can_rename` / `can_delete` / `can_download` flags.

| Role | Meaning |
|---|---|
| `owner` | Full control (manage access, edit, delete) |
| `editor` | Can view and edit / create / rename |
| `viewer` | View / browse only |

---

## Storage — `file_manager_permissions`

| Column | Type | Description |
|---|---|---|
| `item_id` | `BIGINT` | `file_manager_items.id` (folder or file, any scope) |
| `user_id` | `BIGINT` | Assigned user id |
| `username` | `VARCHAR(100)` | Assigned username |
| `role` | `VARCHAR(20)` | `owner` \| `editor` \| `viewer` |
| `assigned_by_username` | `VARCHAR(100)` | Who assigned the role |
| `assigned_at` | `TIMESTAMP` | Assignment time |
| `inherited_from_item_id` | `BIGINT` NULL | Set when this row was cascaded from a parent share. `NULL` = **direct** share |
| `is_childshare` | `BOOLEAN` NOT NULL DEFAULT `TRUE` | **Direct shares only:** `true` = share all children; `false` = this item only |

Unique key: `(item_id, user_id)`.

---

## Child sharing (`is_childshare`)

Google Drive–style control when assigning a role on a folder/file:

| `is_childshare` | Behavior |
|---|---|
| `true` (default) | Role is stored on this item **and** every descendant folder/file. Child rows get `inherited_from_item_id =` the shared item and `is_childshare = false`. New children created under that folder also inherit the share. |
| `false` | Role is stored on **this item only**. Children are **not** shared. Previously cascaded child rows for that user are removed. |

Aliases accepted in the API body: `is_childshare`, `is_child_share`, `isChildShare`, `child_share`, `childShare`.

### Examples

**Share folder + all children**

```json
{
  "item_id": 37,
  "user_id": 18,
  "username": "ADP",
  "role": "viewer",
  "is_childshare": true
}
```

**Share this folder only (no children)**

```json
{
  "item_id": 37,
  "user_id": 18,
  "username": "ADP",
  "role": "viewer",
  "is_childshare": false
}
```

---

## Owned vs Shared with me

| Location | What shows |
|---|---|
| **My Folder** / `GET /file-manager/folders/:id/children` | Items you **own** |
| **Shared with me** / `GET /file-manager/shared-with-me` | Items another user **directly** shared with you (`inherited_from_item_id IS NULL`) |

Rules:

- Cascaded child permission rows do **not** appear as separate roots in Shared with me.
- If a parent (e.g. FY `2026-27`) is already shared with you, a child project under it is **not** listed again at Shared with me root — open it inside the parent.
- Access `role` / `is_owner` come only from the assigned permission role — never invented from `folder.owner_id`.

Browse shared folder contents:

```http
GET /api/file-manager/shared-with-me/folders/{folderId}/children
```

Children inherit the parent role only when the parent share has `is_childshare: true` (or the child already has its own permission row from cascade).

---

## API — any item

Base URL: `/api/file-manager/permissions`

Works on **any** `file_manager_items` row (personal / FY / project folder or file). Scope is taken from the item — no `scope` query required.

| Action | Method | URL |
|---|---|---|
| List users | `GET` | `/api/file-manager/permissions?item_id=3096` |
| Check access | `GET` | `/api/file-manager/permissions/access?item_id=3096&user_id=18` |
| Create / upsert | `POST` | `/api/file-manager/permissions` |
| Update | `PUT` | `/api/file-manager/permissions/:itemId` or `/api/file-manager/permissions` |
| Remove | `DELETE` | `/api/file-manager/permissions?item_id=3096&user_id=18` |

### Create / upsert

```http
POST /api/file-manager/permissions
Authorization: Bearer <token>
Content-Type: application/json

{
  "item_id": 3096,
  "user_id": 18,
  "username": "TMM",
  "role": "viewer",
  "is_childshare": true
}
```

Bulk (per-user `is_childshare` optional; top-level flag applies when omitted on a user row):

```json
{
  "item_id": 3096,
  "is_childshare": true,
  "users": [
    { "user_id": 18, "username": "TMM", "role": "viewer" },
    { "user_id": 22, "username": "rita", "role": "editor", "is_childshare": false }
  ]
}
```

**Success response (excerpt):**

```json
{
  "success": true,
  "message": "Permissions saved on this folder/file and all child folders/files",
  "item_id": 3096,
  "is_childshare": true,
  "cascaded_item_count": 12,
  "data": [
    {
      "id": 1,
      "item_id": 3096,
      "user_id": 18,
      "username": "TMM",
      "role": "viewer",
      "is_childshare": true,
      "inherited_from_item_id": null,
      "is_owner": false,
      "access": { "role": "viewer", "is_owner": false }
    }
  ]
}
```

When `is_childshare` is `false`, message is:
`Permissions saved on this folder/file only (children not shared)`.

### Update

```http
PUT /api/file-manager/permissions/3096
Authorization: Bearer <token>
Content-Type: application/json

{
  "item_id": 3096,
  "user_id": 18,
  "username": "TMM",
  "role": "editor",
  "is_childshare": false
}
```

`username` and `role` are required on update. Optional `is_childshare`:

- `true` → re-cascade role to all children
- `false` → keep role on this item only; clear previously inherited child rows for that user

### Remove

```http
DELETE /api/file-manager/permissions?item_id=3096&user_id=18
```

Removes the direct share and any rows inherited from that item for the same user.

### Success row shape

```json
{
  "id": 1,
  "item_id": 3096,
  "user_id": 18,
  "username": "TMM",
  "role": "editor",
  "assigned_by_username": "admin",
  "assigned_at": "2026-10-08T09:00:00.000Z",
  "inherited_from_item_id": null,
  "is_childshare": true,
  "is_owner": false,
  "access": {
    "role": "editor",
    "is_owner": false
  }
}
```

### Check access (not assigned)

```json
{
  "success": true,
  "item_id": 3096,
  "user_id": 18,
  "username": "TMM",
  "data": {
    "role": null
  }
}
```

---

## Project / PCB create — automatic roles

When creating a project folder structure (`POST /api/project-file-manager`) or PCB folders:

| Who | Role assigned |
|---|---|
| File Manager **Settings owners** | `owner` |
| **Creating user** (authenticated actor) | `editor` (stays `owner` if they are already a settings owner) |
| **Assign users** in payload (`users` / `assign_users`) | `viewer` (never downgrades `owner` / `editor`) |

Roles are applied to the project root and every created structure / PCB folder (`is_childshare` cascade behavior via project create).

Assign-user payload on create (identity only — role is forced to `viewer`):

```json
{
  "project_code": "PRJ-2024-001",
  "category_id": 5,
  "users": [
    { "user_id": 18, "username": "TMM" }
  ]
}
```

### Edit Project — Assign Users (frontend)

On **Save** in Edit Project (`editProjectModel.tsx`):

1. Diff previous vs new `assigned_user_names`
2. Added users → `POST /file-manager/permissions` with `role: "editor"`, `is_childshare: true` on the project FM folder
3. Removed users → `DELETE /file-manager/permissions?item_id=…&user_id=…`

Permission APIs are **not** called while picking users in the UI — only on Save.

Frontend helpers (do not change API contracts here):

- `redux/slices/fileManager/sharedWithMe/permissions/sharedWithMePermissionAPI.ts`
- Types include optional `is_childshare` on `SaveFolderPermissionPayload`

---

## Shared with me

```http
GET /api/file-manager/shared-with-me?page=1&limit=48
Authorization: Bearer <token>
```

Returns **direct** shares only (project, financial year, and personal), excluding owned items and excluding inherited child rows.

```http
GET /api/file-manager/shared-with-me/folders/{folderId}/children
Authorization: Bearer <token>
```

| `folderId` | Behavior |
|---|---|
| Project root or nested project item | Lists DB children with access from permission rows / parent `is_childshare` |
| FY root | Lists project folders under that FY (real `id` / `parent_id` from DB) |
| Personal shared folder | Lists personal children |

Roots and children include `role` and `access` (`role`, `is_owner`, `current_username`), plus `public_id` (16-byte base64url unique URL id, e.g. `1n7Eiy0YN-hERtdvu9Xecf`).

Permission responses also expose `item.public_id` via `item` meta.

---

## Folder download (any scope)

```http
GET /api/file-manager/folders/{id}/download
Authorization: Bearer <token>
```

Zips the folder from disk. Supports **personal, project, and financial-year** items (`anyScope`). Access: owner/admin, or a share role on the item / an ancestor.

---

## Authentication

| Header | Required |
|---|---|
| `Authorization: Bearer <token>` | Yes |
| `Content-Type: application/json` | POST / PUT |

`assigned_by_username` is taken from the authenticated actor.

---

## Related docs

- [filemanagerAPI.md](./filemanagerAPI.md) — personal file manager + permissions summary
- [projectFilemanager.md](./projectFilemanager.md) — project / PCB create + shared with me
- [financialYearFileManager.md](./financialYearFileManager.md) — FY folders + owners
