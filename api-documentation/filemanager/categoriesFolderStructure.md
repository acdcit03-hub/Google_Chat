# Categories Folder Structure API

Base URL: `/api/categories-folder-structure`

All endpoints return JSON responses.

---

## Table of Contents

- [Overview & Architecture](#overview--architecture)
- [Database Schema](#database-schema)
- [Authentication and Headers](#authentication-and-headers)
- [Common Response Formats](#common-response-formats)
- [API Endpoints](#api-endpoints)
  - [1. List Folder Structures](#1-list-folder-structures)
  - [2. Get Structures by Category ID](#2-get-structures-by-category-id)
  - [3. Get Direct Children of a Node](#3-get-direct-children-of-a-node)
  - [4. Get Folder Structure by ID](#4-get-folder-structure-by-id)
  - [5. Create Folder Structure Node](#5-create-folder-structure-node)
  - [6. Update Folder Structure Node](#6-update-folder-structure-node)
  - [7. Delete Folder Structure Node](#7-delete-folder-structure-node)
- [Frontend Integration Guide: Building Tree Hierarchies](#frontend-integration-guide-building-tree-hierarchies)

---

## Overview & Architecture

The **Categories Folder Structure API** provides a centralized system for defining standardized folder templates and hierarchical folder trees for business categories (such as Timesheet, Engineering, R&D, or Production project categories).

### Key Features

| Feature | Description |
|---|---|
| **Hierarchical Structure** | Built-in recursive parent-child tree using `parent_id` with `ON DELETE CASCADE`. Supports arbitrary depth (Root &rarr; Subfolder &rarr; Sub-subfolder). |
| **Category Association** | Links structure nodes to a specific category via `category_id`, with optional metadata snapshots (`category_name`, `category_letter`). |
| **Template Paths** | Stores `folder_path` templates (e.g. `Electrical/Schematics/Altium`) used to provision actual storage directories on disk or in the File Manager. |
| **Ordering & Display** | Ordered by `display_order ASC, id ASC` to guarantee deterministic UI presentation in file trees. |
| **Status Management** | Soft toggle with `is_active` boolean to enable or disable template nodes without deletion. |

---

## Database Schema

The database table `categories_folder_structure` is automatically initialized on server startup via `initializeCategoriesFolderStructureTable()`.

### Table: `categories_folder_structure`

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | `BIGSERIAL` | `PRIMARY KEY` | Unique identifier for the folder structure node |
| `category_id` | `BIGINT` | `NULL` | ID of the associated category (e.g. from categories table) |
| `category_name` | `VARCHAR(255)` | `NULL` | Name of the category snapshot |
| `category_letter` | `VARCHAR(20)` | `NULL` | Category letter code / prefix (e.g., `"A"`, `"B"`, `"ENG"`) |
| `parent_id` | `BIGINT` | `NULL`, `REFERENCES categories_folder_structure(id) ON DELETE CASCADE` | Self-referencing parent node ID for subfolder nesting. `NULL` denotes root-level folder |
| `folder_name` | `VARCHAR(255)` | `NOT NULL` | Display name of the folder (supports `{PROJECT}` / `{PCB}` placeholders) |
| `folder_path` | `TEXT` | `NOT NULL` | Relative path representation or template path |
| `folder_scope` | `VARCHAR(20)` | `NOT NULL DEFAULT 'project'` | Expansion scope: `project` (once per project) or `pcb` (once per PCB under the project) |
| `display_order` | `INTEGER` | `NOT NULL DEFAULT 0` | Sort order among sibling nodes |
| `is_active` | `BOOLEAN` | `NOT NULL DEFAULT TRUE` | Active/enabled status flag |
| `created_by` | `BIGINT` | `NULL` | User ID of the creator |
| `created_at` | `TIMESTAMP` | `DEFAULT CURRENT_TIMESTAMP` | Record creation timestamp |
| `updated_at` | `TIMESTAMP` | `DEFAULT CURRENT_TIMESTAMP` | Last update timestamp |

### Indexes

- `idx_cat_folder_struct_category_id` on `category_id`
- `idx_cat_folder_struct_parent_id` on `parent_id`
- `idx_cat_folder_struct_letter` on `category_letter`
- `idx_cat_folder_struct_active` on `is_active`
- `idx_cat_folder_struct_display_order` on `display_order`
- `idx_cat_folder_struct_folder_scope` on `folder_scope`

### `folder_scope` behavior

| Value | When project folder is created |
|---|---|
| `project` (default) | Folder is created once under the project root |
| `pcb` | Folder is expanded once per project PCB (naming uses `{PROJECT}_{PCB}` / `{PROJECT}_{PCB}_SUFFIX`) |

Dynamic name tokens in `folder_name`: `{PROJECT}`, `{PCB}`.

---

## Authentication and Headers

All requests inherit the application middleware stack. When authentication is enabled, requests should pass standard bearer tokens or user identity headers:

| Header | Required | Description |
|---|---|---|
| `Authorization: Bearer <token>` | Recommended | JWT token containing user identity (`id`, `username`, `access`) |
| `x-user-id` | Fallback | User numeric identifier |
| `x-username` | Fallback | Username for auditing |
| `Content-Type: application/json` | Yes | Required for `POST` and `PUT` request bodies |

---

## Common Response Formats

### Standard Success Response

```json
{
  "success": true,
  "data": {}
}
```

Or for creation/update/deletion actions:

```json
{
  "success": true,
  "message": "Folder structure created",
  "data": {}
}
```

### Standard Error Response

```json
{
  "success": false,
  "message": "folder_name and folder_path are required"
}
```

### HTTP Status Codes

| Code | Meaning | Typical Scenario |
|---|---|---|
| `200 OK` | Request succeeded | Successful GET, PUT, or DELETE operations |
| `201 Created` | Resource created | Successful POST creation |
| `400 Bad Request` | Invalid input | Missing required fields, invalid numeric IDs, or self-referential `parent_id` |
| `401 Unauthorized` | Missing authentication | User context missing when authentication is required |
| `404 Not Found` | Resource not found | Item with specified ID does not exist |
| `500 Internal Error` | Server error | Database connection or unhandled server exception |

---

## API Endpoints

### 1. List Folder Structures

**API name:** List category folder structures  
**Method:** `GET /api/categories-folder-structure`  
**Description:** Fetches folder structure definitions with optional filtering by category, parent node, active status, or search keyword.

#### Query Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `category_id` (or `categoryId`) | `number` | No | Filter by category ID |
| `parent_id` (or `parentId`) | `number` \| `string` | No | Filter by parent node ID. Pass `null` or empty string to retrieve only root-level nodes (`parent_id IS NULL`) |
| `is_active` (or `isActive`) | `boolean` \| `string` | No | Filter active status (`true`, `false`, `1`, `0`) |
| `search` | `string` | No | Case-insensitive search matching `folder_name`, `folder_path`, `category_name`, or `category_letter` |

#### Request Example

```http
GET /api/categories-folder-structure?category_id=12&is_active=true HTTP/1.1
Authorization: Bearer <token>
```

#### Success Response (`200 OK`)

```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "category_id": 12,
      "category_name": "Embedded Systems",
      "category_letter": "ES",
      "parent_id": null,
      "folder_name": "Firmware",
      "folder_path": "Firmware",
      "display_order": 1,
      "is_active": true,
      "created_by": 5,
      "created_at": "2026-09-01T10:00:00.000Z",
      "updated_at": "2026-09-01T10:00:00.000Z"
    },
    {
      "id": 2,
      "category_id": 12,
      "category_name": "Embedded Systems",
      "category_letter": "ES",
      "parent_id": 1,
      "folder_name": "Source Code",
      "folder_path": "Firmware/Source Code",
      "display_order": 1,
      "is_active": true,
      "created_by": 5,
      "created_at": "2026-09-01T10:05:00.000Z",
      "updated_at": "2026-09-01T10:05:00.000Z"
    },
    {
      "id": 3,
      "category_id": 12,
      "category_name": "Embedded Systems",
      "category_letter": "ES",
      "parent_id": 1,
      "folder_name": "Binaries",
      "folder_path": "Firmware/Binaries",
      "display_order": 2,
      "is_active": true,
      "created_by": 5,
      "created_at": "2026-09-01T10:06:00.000Z",
      "updated_at": "2026-09-01T10:06:00.000Z"
    }
  ]
}
```

---

### 2. Get Structures by Category ID

**API name:** Get folder structures by category  
**Method:** `GET /api/categories-folder-structure/category/:categoryId`  
**Description:** Retrieves all folder structure records associated with a specific `categoryId`, sorted by `display_order ASC, id ASC`.

#### URL Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `categoryId` | `number` | Yes | Numeric category ID (> 0) |

#### Request Example

```http
GET /api/categories-folder-structure/category/12 HTTP/1.1
Authorization: Bearer <token>
```

#### Success Response (`200 OK`)

```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "category_id": 12,
      "category_name": "Embedded Systems",
      "category_letter": "ES",
      "parent_id": null,
      "folder_name": "Firmware",
      "folder_path": "Firmware",
      "display_order": 1,
      "is_active": true,
      "created_by": 5,
      "created_at": "2026-09-01T10:00:00.000Z",
      "updated_at": "2026-09-01T10:00:00.000Z"
    }
  ]
}
```

#### Error Response (`400 Bad Request`)

```json
{
  "success": false,
  "message": "Valid categoryId is required"
}
```

---

### 3. Get Direct Children of a Node

**API name:** Get direct child folder structures  
**Method:** `GET /api/categories-folder-structure/:id/children`  
**Description:** Retrieves direct immediate subfolders where `parent_id` matches the given `:id`.

#### URL Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | `number` | Yes | Parent node ID (> 0) |

#### Request Example

```http
GET /api/categories-folder-structure/1/children HTTP/1.1
Authorization: Bearer <token>
```

#### Success Response (`200 OK`)

```json
{
  "success": true,
  "data": [
    {
      "id": 2,
      "category_id": 12,
      "category_name": "Embedded Systems",
      "category_letter": "ES",
      "parent_id": 1,
      "folder_name": "Source Code",
      "folder_path": "Firmware/Source Code",
      "display_order": 1,
      "is_active": true,
      "created_by": 5,
      "created_at": "2026-09-01T10:05:00.000Z",
      "updated_at": "2026-09-01T10:05:00.000Z"
    },
    {
      "id": 3,
      "category_id": 12,
      "category_name": "Embedded Systems",
      "category_letter": "ES",
      "parent_id": 1,
      "folder_name": "Binaries",
      "folder_path": "Firmware/Binaries",
      "display_order": 2,
      "is_active": true,
      "created_by": 5,
      "created_at": "2026-09-01T10:06:00.000Z",
      "updated_at": "2026-09-01T10:06:00.000Z"
    }
  ]
}
```

#### Error Response (`400 Bad Request`)

```json
{
  "success": false,
  "message": "Valid id is required"
}
```

---

### 4. Get Folder Structure by ID

**API name:** Get folder structure details  
**Method:** `GET /api/categories-folder-structure/:id`  
**Description:** Fetches a single folder structure record by its primary key ID.

#### URL Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | `number` | Yes | Record primary key ID (> 0) |

#### Request Example

```http
GET /api/categories-folder-structure/2 HTTP/1.1
Authorization: Bearer <token>
```

#### Success Response (`200 OK`)

```json
{
  "success": true,
  "data": {
    "id": 2,
    "category_id": 12,
    "category_name": "Embedded Systems",
    "category_letter": "ES",
    "parent_id": 1,
    "folder_name": "Source Code",
    "folder_path": "Firmware/Source Code",
    "display_order": 1,
    "is_active": true,
    "created_by": 5,
    "created_at": "2026-09-01T10:05:00.000Z",
    "updated_at": "2026-09-01T10:05:00.000Z"
  }
}
```

#### Error Responses

- **`400 Bad Request`**: If `:id` is not a valid positive number.
  ```json
  {
    "success": false,
    "message": "Valid id is required"
  }
  ```
- **`404 Not Found`**: If the record does not exist.
  ```json
  {
    "success": false,
    "message": "Folder structure not found"
  }
  ```

---

### 5. Create Folder Structure Node

**API name:** Create folder structure  
**Method:** `POST /api/categories-folder-structure`  
**Description:** Creates a new folder structure record in the hierarchy.

#### Request Body Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `folder_name` (or `folderName`) | `string` | **Yes** | Display name of the folder (may include `{PROJECT}` / `{PCB}`) |
| `folder_path` (or `folderPath`) | `string` | **Yes** | Relative path template for the folder |
| `folder_scope` (or `folderScope`) | `string` | No | `project` (default) or `pcb` |
| `category_id` (or `categoryId`) | `number` | No | Associated category ID |
| `category_name` (or `categoryName`) | `string` | No | Name of the category snapshot |
| `category_letter` (or `categoryLetter`) | `string` | No | Category letter code / prefix |
| `parent_id` (or `parentId`) | `number` \| `null` | No | Parent node ID. Set to `null` for root-level folder |
| `display_order` (or `displayOrder`) | `number` | No | Sort order (defaults to `0`) |
| `is_active` (or `isActive`) | `boolean` | No | Active status (defaults to `true`) |
| `created_by` (or `createdBy`) | `number` | No | User ID creating the record |

#### Request Example

```http
POST /api/categories-folder-structure HTTP/1.1
Content-Type: application/json
Authorization: Bearer <token>

{
  "category_id": 12,
  "category_name": "R&D",
  "category_letter": "R",
  "parent_id": 1,
  "folder_name": "BOM",
  "folder_path": "DESIGN_FILE/BOM",
  "folder_scope": "pcb",
  "display_order": 3,
  "is_active": true
}
```

#### Success Response (`201 Created`)

```json
{
  "success": true,
  "message": "Folder structure created",
  "data": {
    "id": 4,
    "category_id": 12,
    "category_name": "Embedded Systems",
    "category_letter": "ES",
    "parent_id": 1,
    "folder_name": "BOM",
    "folder_path": "DESIGN_FILE/BOM",
    "folder_scope": "pcb",
    "display_order": 3,
    "is_active": true,
    "created_by": null,
    "created_at": "2026-10-02T10:15:00.000Z",
    "updated_at": "2026-10-02T10:15:00.000Z"
  }
}
```

#### Error Response (`400 Bad Request`)

```json
{
  "success": false,
  "message": "folder_name and folder_path are required"
}
```

---

### 6. Update Folder Structure Node

**API name:** Update folder structure  
**Method:** `PUT /api/categories-folder-structure/:id`  
**Description:** Updates an existing folder structure node. Supports partial updates; unprovided fields retain their existing values.

> [!CAUTION]
> A node's `parent_id` cannot be set to its own `id`. Doing so triggers a `400 Bad Request` validation error.

#### URL Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | `number` | Yes | Record primary key ID (> 0) |

#### Request Body Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `folder_name` (or `folderName`) | `string` | No | Updated folder display name |
| `folder_path` (or `folderPath`) | `string` | No | Updated path template |
| `folder_scope` (or `folderScope`) | `string` | No | `project` or `pcb` |
| `category_id` (or `categoryId`) | `number` | No | Updated category ID |
| `category_name` (or `categoryName`) | `string` | No | Updated category name |
| `category_letter` (or `categoryLetter`) | `string` | No | Updated category letter |
| `parent_id` (or `parentId`) | `number` \| `null` | No | Updated parent node ID (`!= id`) |
| `display_order` (or `displayOrder`) | `number` | No | Updated sort order integer |
| `is_active` (or `isActive`) | `boolean` | No | Updated active flag |

#### Request Example

```http
PUT /api/categories-folder-structure/4 HTTP/1.1
Content-Type: application/json
Authorization: Bearer <token>

{
  "folder_name": "Technical Documentation",
  "folder_path": "Firmware/Technical Documentation",
  "display_order": 4
}
```

#### Success Response (`200 OK`)

```json
{
  "success": true,
  "message": "Folder structure updated",
  "data": {
    "id": 4,
    "category_id": 12,
    "category_name": "Embedded Systems",
    "category_letter": "ES",
    "parent_id": 1,
    "folder_name": "Technical Documentation",
    "folder_path": "Firmware/Technical Documentation",
    "display_order": 4,
    "is_active": true,
    "created_by": null,
    "created_at": "2026-10-02T10:15:00.000Z",
    "updated_at": "2026-10-02T10:20:00.000Z"
  }
}
```

#### Error Responses

- **`400 Bad Request`**:
  ```json
  {
    "success": false,
    "message": "parent_id cannot reference itself"
  }
  ```
- **`404 Not Found`**:
  ```json
  {
    "success": false,
    "message": "Folder structure not found"
  }
  ```

---

### 7. Delete Folder Structure Node

**API name:** Delete folder structure  
**Method:** `DELETE /api/categories-folder-structure/:id`  
**Description:** Deletes a folder structure node by its ID.

> [!WARNING]
> Because `parent_id` is defined with `ON DELETE CASCADE`, deleting a parent node automatically deletes all of its nested child and grandchild nodes in the database.

#### URL Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | `number` | Yes | Record primary key ID (> 0) |

#### Request Example

```http
DELETE /api/categories-folder-structure/4 HTTP/1.1
Authorization: Bearer <token>
```

#### Success Response (`200 OK`)

```json
{
  "success": true,
  "message": "Folder structure deleted",
  "data": {
    "id": 4,
    "category_id": 12,
    "category_name": "Embedded Systems",
    "category_letter": "ES",
    "parent_id": 1,
    "folder_name": "Technical Documentation",
    "folder_path": "Firmware/Technical Documentation",
    "display_order": 4,
    "is_active": true,
    "created_by": null,
    "created_at": "2026-10-02T10:15:00.000Z",
    "updated_at": "2026-10-02T10:20:00.000Z"
  }
}
```

#### Error Responses

- **`400 Bad Request`**:
  ```json
  {
    "success": false,
    "message": "Valid id is required"
  }
  ```
- **`404 Not Found`**:
  ```json
  {
    "success": false,
    "message": "Folder structure not found"
  }
  ```

---

## Frontend Integration Guide: Building Tree Hierarchies

When fetching nodes with `GET /api/categories-folder-structure?category_id=X`, the response is a flat list. To render a nested tree structure (e.g. for an Ant Design Tree, React Treebeard, or custom folder view), use this standard helper utility:

```typescript
export interface CategoryFolderStructureItem {
  id: number;
  category_id: number | null;
  category_name: string | null;
  category_letter: string | null;
  parent_id: number | null;
  folder_name: string;
  folder_path: string;
  display_order: number;
  is_active: boolean;
  created_by: number | null;
  created_at: string;
  updated_at: string;
  children?: CategoryFolderStructureItem[];
}

/**
 * Transforms flat array into nested tree hierarchy
 */
export function buildFolderTree(
  items: CategoryFolderStructureItem[]
): CategoryFolderStructureItem[] {
  const map = new Map<number, CategoryFolderStructureItem>();
  const roots: CategoryFolderStructureItem[] = [];

  // Deep clone items and index by ID
  items.forEach(item => {
    map.set(item.id, { ...item, children: [] });
  });

  // Assemble parent-child tree
  items.forEach(item => {
    const current = map.get(item.id)!;
    if (item.parent_id && map.has(item.parent_id)) {
      map.get(item.parent_id)!.children!.push(current);
    } else {
      roots.push(current);
    }
  });

  return roots;
}
```
