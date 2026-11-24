# Project PCB Version API

Base path: `/api/project-pcb-versions`

Table: `project_pcb_version`  
Unique: `(pcb_id, version)` (case-insensitive)

## Fields

| Field | Type | Required (create) |
|-------|------|-------------------|
| `project_id` | number | yes |
| `project_code` | string | yes |
| `pcb_id` | number | yes |
| `pcb_code` | string | yes |
| `pcb_name` | string | yes |
| `version` | string (≤20) | yes |
| `status` | boolean | no (default `true`) |

**Read-only on responses:** `process_map` comes from `"PCB".process_map` (joined by `pcb_id`). It is **not** stored on `project_pcb_version`.

---

## GET `/project-pcb-versions`

List / filter (paginated).

Query:

- `project_id`, `project_code`
- `pcb_id`, `pcb_code`
- `version`, `status`
- `page`, `limit` (default 50, max 500)
- `all=true` — skip pagination

Response:

```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "project_id": 10,
      "project_code": "055RAECGREV051026",
      "pcb_id": 5,
      "pcb_code": "0691026",
      "pcb_name": "Main Board",
      "version": "V01",
      "status": true,
      "process_map": { "main_processes": [] }
    }
  ],
  "pagination": { "total": 1, "limit": 50, "page": 1, "totalPages": 1 }
}
```

---

## GET `/project-pcb-versions/:id`

Get one by id.

---

## GET `/project-pcb-versions/project/:projectId`

All versions for a project.

Query: `active_only=true` — only `status=true`.

---

## GET `/project-pcb-versions/pcb/:pcbId`

All versions for a PCB.

Query: `active_only=true`.

---

## POST `/project-pcb-versions`

Create.

```json
{
  "project_id": 10,
  "project_code": "001MABC0010010326",
  "pcb_id": 5,
  "pcb_code": "001/03/26",
  "pcb_name": "Main Board",
  "version": "V01",
  "status": true
}
```

CamelCase aliases accepted (`projectId`, `pcbCode`, …).

---

## PUT `/project-pcb-versions/:id`

Update any subset of fields (same body keys as create).

---

## PATCH `/project-pcb-versions/:id/status`

```json
{ "status": false }
```
