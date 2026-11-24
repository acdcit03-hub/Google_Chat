# HRMS-Backend

A comprehensive **Human Resource Management System (HRMS)** backend built with Node.js, featuring MQTT-based real-time attendance tracking through RFID devices and PostgreSQL database integration.

## 1. Overview

The HRMS Backend provides a complete solution for:
- **Real-time Attendance Tracking** via MQTT-connected RFID devices
- **Employee Management** with personal details and profiles
- **Shift & Department Management** for organizational structure
- **Device Configuration** for multiple attendance devices
- **Live Dashboard** with WebSocket real-time updates
- **Cloud File Storage** with Cloudinary integration

-----------------------------------------------------------------------------------------------------------

## 2. Features

### Core Features
- **MQTT Integration** - Real-time attendance capture from RFID devices
- **Employee Management** - Complete employee profiles and personal details
- **Attendance Tracking** - Automated attendance logging with validation
- **Device Management** - Configure and monitor multiple RFID devices
- **Shift Configuration** - Define and manage employee shifts
- **Department Organization** - Organize employees by departments and bonds
- **Real-time WebSocket** - Live updates to connected clients
- **Cloud File Upload** - Integrate with Cloudinary for image storage
- **RESTful API** - Complete API for all operations
- **Error Handling** - Comprehensive error handling and logging
- **Security** - SSL/TLS encryption and credential management

### Advanced Features
- Message deduplication and duplicate detection
- Device health monitoring and status tracking
- Attendance validation and business logic
- Database transactions for data integrity
- Request logging and audit trails
- Automatic reconnection with exponential backoff
- QoS (Quality of Service) message delivery


-----------------------------------------------------------------------------------------------------------

## 3. Getting Started

### Prerequisites

Before you begin, ensure you have installed:
- **Node.js** (v14.0.0 or higher) - [Download](https://nodejs.org/)
- **PostgreSQL** (v12 or higher) - [Download](https://www.postgresql.org/)
- **npm** or **yarn** - Comes with Node.js

### Installation Steps

1. **Clone the repository:**
```bash
git clone <repository-url>
cd HRMS-Backend
```

2. **Navigate to Server directory:**
```bash
cd Server
```

3. **Install dependencies:**
```bash
npm install
```

4. **Configure environment variables:**

Create `.env` file in `Server/` directory:
```bash
cp .env.example .env
```

5. **Edit `.env` with your settings:**
```env
# Database Configuration
DB_HOST=localhost
DB_PORT=5432
DB_NAME=hrms_database
DB_USER=postgres
DB_PASSWORD=your_password

# MQTT Configuration
MQTT_HOST=broker.hivemq.cloud
MQTT_PORT=8883
MQTT_USER=your_mqtt_username
MQTT_PASSWORD=your_mqtt_password
MQTT_USE_SSL=true
MQTT_CLIENT_ID=attendance_server
MQTT_RECONNECT_PERIOD=5000
MQTT_QOS=1

# Server Configuration
PORT=3000
NODE_ENV=development
LOG_LEVEL=info

# Cloudinary (File Uploads)
CLOUDINARY_NAME=your_cloudinary_name
CLOUDINARY_API_KEY=your_api_key
CLOUDINARY_API_SECRET=your_api_secret

# Session/Security
SESSION_SECRET=your_secret_key_min_32_chars
JWT_SECRET=your_jwt_secret_key
```

6. **Initialize database:**

Create PostgreSQL database:
```bash
createdb hrms_database
```

Run migrations (if using migrations):
```bash
npm run migrate
```

7. **Start the server:**
```bash
npm start
```

Server will start on `http://localhost:3000`

-----------------------------------------------------------------------------------------------------------

## 4. Configuration Guide

### MQTT Configuration

The system uses MQTT for real-time attendance capture from RFID devices.

**Key Environment Variables:**
- `MQTT_HOST` - MQTT broker hostname
- `MQTT_PORT` - MQTT broker port (8883 for SSL, 1883 for non-SSL)
- `MQTT_USER` - MQTT authentication username
- `MQTT_PASSWORD` - MQTT authentication password
- `MQTT_USE_SSL` - Enable/disable SSL encryption

For detailed MQTT setup, see [MQTT_INTEGRATION.md](MQTT_INTEGRATION.md).

### Database Configuration

The system uses PostgreSQL for persistent data storage.

**Connection Parameters:**
- `DB_HOST` - Database server hostname/IP
- `DB_PORT` - Database server port
- `DB_NAME` - Database name
- `DB_USER` - Database user
- `DB_PASSWORD` - Database password

### Cloudinary Configuration

For cloud-based file uploads:

1. Create account at [Cloudinary](https://cloudinary.com/)
2. Get API credentials from dashboard
3. Set environment variables:
   ```env
   CLOUDINARY_NAME=<Your Cloud Name>
   CLOUDINARY_API_KEY=<Your API Key>
   CLOUDINARY_API_SECRET=<Your API Secret>
   ```

-----------------------------------------------------------------------------------------------------------

## 5. System Flow

```
RFID Device
    │
    │  1. Scan RFID Card
    ▼
MQTT Publish (MAC/pub)
    │   Example:
    │   14335C698624/pub
    ▼
MQTT Broker (HiveMQ / Cloud Broker)
    │
    ▼
Node.js MQTT Listener
    │
    ├── Validate Payload
    ├── Check MAC ID
    ├── Verify RFID UID
    ├── Check Message ID (Duplicate Prevention)
    │
    ▼
Attendance Processing Service
    │
    ├── Employee Lookup (RFID → Employee)
    ├── Shift Validation
    ├── Time In / Time Out Logic
    ├── Attendance Record Insert (PostgreSQL)
    │
    ▼
ACK Generator
    │
    ▼
MQTT Publish (MAC/sub)
    │   Example:
    │   14335C698624/sub
    │   {
    │     "ack": true,
    │     "message_id": 169471
    │   }
    ▼
RFID Device Receives ACK
    │
    ▼
Device Confirms Attendance Success
```

-----------------------------------------------------------------------------------------------------------

## 6. API Base URL

```
http://localhost:8000
```

All APIs use prefix:

```
/api
```
-----------------------------------------------------------------------------------------------------------

## 7. API Endpoints

#### Shifts

#### ➤ Add Shift
```
POST /api/shift/add-shift
```

### Success Response

```json
{
    "success": true,
    "message": "Shift created successfully",
    "data": {
        "id": 2,
        "shift_name": "Evening Shift",
        "shift_type": "Evening",
        "start_time": "02:00:00",
        "end_time": "06:30:00",
        "description": "Regular evening shift",
        "status": "active",
        "created_at": "2026-06-09T11:44:44.664Z",
        "updated_at": "2026-06-09T11:44:44.664Z"
    }
}
```

#### ➤ Get Shift
```
GET /api/shift/all-shift
```

### Success Response

```json
{
    "success": true,
    "message": "Shifts retrieved successfully",
    "data": [
        {
            "id": 5,
            "shift_name": "IT2",
            "shift_type": "Morning",
            "start_time": "01:00:00",
            "end_time": "06:30:00",
            "description": "Regular evening shift",
            "status": "deactive",
            "created_at": "2026-06-10T12:04:32.734Z",
            "updated_at": "2026-06-12T10:58:27.409Z",
            "created_by": "system"
        },  
        {   
            "id": 4,
            "shift_name": "R&D",
            "shift_type": "Morning",
            "start_time": "09:00:00",
            "end_time": "18:30:00",
            "description": "Regular morning shift",
            "status": "active",
            "created_at": "2026-06-10T07:18:09.931Z",
            "updated_at": "2026-06-12T04:14:23.532Z",
            "created_by": null
        }
    ]
}
```

#### ➤ Update Shift
```
PUT /api/shift/update-shift/:id
```

```
PUT /api/shift/update-shift/1
```

### Success Response

```json
{
    "success": true,
    "message": "Shift updated successfully",
    "data": {
        "id": 1,
        "shift_name": "Morning Shift",
        "shift_type": "Morning",
        "start_time": "09:00:00",
        "end_time": "06:30:00",
        "description": "Regular office shift",
        "status": "active",
        "created_at": "2026-06-09T11:39:58.675Z",
        "updated_at": "2026-06-09T11:43:36.249Z"
    }
}
```

#### ➤ Update Toggle
```
PATCH /api/shift/toggle/:id
```

```
PATCH /api/shift/toggle/1
```

### Success Response
```json
{
    "success": true,
    "message": "Shift status updated successfully",
    "data": {
        "id": 1,
        "shift_name": "Morning Shift",
        "shift_type": "Evening",
        "start_time": "09:00:00",
        "end_time": "06:30:00",
        "description": "Regular office shift",
        "status": "deactive",
        "created_at": "2026-06-09T11:39:58.675Z",
        "updated_at": "2026-06-13T05:14:27.262Z",
        "created_by": null
    }
}
```

-----------------------------------------------------------------------------------------------------------

#### Bond

#### ➤ Add Bond
```
POST /api/bond/add-bond
```

### Success Response
```json
{
    "success": true,
    "message": "Bond option added successfully",
    "data": {
        "id": 4,
        "bond_duration": "2 Years",
        "duration_months": 24,
        "status": "active",
        "created_at": "2026-06-09T12:08:23.771Z",
        "updated_at": "2026-06-09T12:08:23.771Z"
    }
}
```

#### ➤ Get Bond
```
GET /api/bond/all-bond
```

### Success Response
```json
{
    "success": true,
    "message": "Bond option Fetched successfully",
    "data": [
        {
            "id": 2,
            "bond_duration": "1 Years",
            "duration_months": 12,
            "status": "active",
            "created_at": "2026-06-09T12:07:54.808Z",
            "updated_at": "2026-06-11T04:51:22.975Z",
            "created_by": null
        },
        {
            "id": 1,
            "bond_duration": "1.2 year",
            "duration_months": 3,
            "status": "active",
            "created_at": "2026-06-09T12:07:51.713Z",
            "updated_at": "2026-06-11T06:55:57.337Z",
            "created_by": null
        }
    ]
}
```

#### ➤ Get by id Bond
```
GET /api/bond/:id
```

```
GET /api/bond/1
```

### Success Response
```json
{
    "success": true,
    "message": "Bond option by id Fetched successfully",
    "data": {
        "id": 1,
        "bond_duration": "1.2 year",
        "duration_months": 3,
        "status": "active",
        "created_at": "2026-06-09T12:07:51.713Z",
        "updated_at": "2026-06-11T06:55:57.337Z",
        "created_by": null
    }
}
```

#### ➤ Update Bond
```
PUT /api/bond/update-bond/:id
```

```
PUT /api/bond/update-bond/1
```

### Success Response
```json
{
    "success": true,
    "message": "Bond option updated successfully",
    "data": {
        "id": 1,
        "bond_duration": "6 Months",
        "duration_months": 6,
        "status": "active",
        "created_at": "2026-06-09T12:04:00.265Z",
        "updated_at": "2026-06-09T12:06:02.645Z"
    }
}
```

#### ➤ Update Toggle
```
PATCH /api/bond/toggle/:id
```

```
PATCH /api/bond/toggle/1
```

### Success Response
```json
{
    "success": true,
    "message": "Status updated successfully",
    "data": {
        "id": 1,
        "bond_duration": "1.2 year",
        "duration_months": 3,
        "status": "deactive",
        "created_at": "2026-06-09T12:07:51.713Z",
        "updated_at": "2026-06-13T05:49:08.471Z",
        "created_by": null
    }
}
```

-----------------------------------------------------------------------------------------------------------

#### Location

#### ➤ Add Location
```
POST /api/location/add-location
```

### Success Response
```json
{
    "message": "Location added successfully",
    "data": {
        "id": 1,
        "location": "ACDC TECH",
        "address": "405, Amora Arcade, near Mauni International School, Mota Varachha - Uttran, Surat, Gujarat 394105, India",
        "city": "Surat",
        "state": "Gujarat",
        "zip": "394105",
        "created_by": null,
        "status": "active",
        "created_at": "2026-06-11T05:41:22.658Z",
        "updated_at": "2026-06-11T05:41:22.658Z"
    }
}
```

#### ➤ Get Location
```
GET /api/location/all-location
```

### Success Response
```json
{
    "message": "Location fetched successfully",
    "data": [
        {
            "id": 2,
            "location": "ACDC TECH",
            "address": "405, Amora Arcade, near Mauni International School, Mota Varachha - Uttran, Surat, Gujarat 394105, India",
            "city": "Surat",
            "state": "GUJARAT",
            "zip": "394105",
            "created_by": null,
            "status": "active",
            "created_at": "2026-06-11T08:40:34.729Z",
            "updated_at": "2026-06-12T11:51:27.618Z"
        },
        {
            "id": 1,
            "location": "EMBLEPCB",
            "address": "402-B & 405 ACDC, Amora Arcade, Near Mauni International School, Digital Valley, Utran, Surat, Gujarat 394105, India",
            "city": "Surat",
            "state": "GUJARAT ",
            "zip": "394103",
            "created_by": null,
            "status": "active",
            "created_at": "2026-06-11T08:38:04.899Z",
            "updated_at": "2026-06-12T05:26:56.081Z"
        }
    ]
}
```

#### ➤ Update Location
```
PUT /api/location/update-location/:id
```

```
PUT /api/location/update-location/1
```

### Success Response
```json
{
    "message": "Location updated successfully",
    "data": {
        "id": 1,
        "location": "ACDC TECH",
        "address": "405, Amora Arcade, near Mauni International School, Mota Varachha - Uttran, Surat, Gujarat 394105, India",
        "city": "Surat",
        "state": "Gujarat",
        "zip": "394105",
        "username": null,
        "status": "active",
        "created_at": "2026-06-09T12:54:56.437Z",
        "updated_at": "2026-06-09T12:58:23.340Z"
    }
}
```

#### ➤ Update Toggle
```
PATCH /api/location/toggle/:id
```

```
PATCH /api/location/toggle/1
```

### Success Response
```json
{
    "message": "Location deactive successfully",
    "data": {
        "id": 1,
        "location": "EMBLEPCB",
        "address": "402-B & 405 ACDC, Amora Arcade, Near Mauni International School, Digital Valley, Utran, Surat, Gujarat 394105, India",
        "city": "Surat",
        "state": "GUJARAT ",
        "zip": "394103",
        "created_by": null,
        "status": "deactive",
        "created_at": "2026-06-11T08:38:04.899Z",
        "updated_at": "2026-06-13T05:40:16.157Z"
    }
}
```

-----------------------------------------------------------------------------------------------------------

#### Departments

#### ➤ Add Departments
```
POST /api/department/add-department
```

### Success Response
```json
{
    "success": true,
    "message": "Department added successfully",
    "data": {
        "id": 3,
        "department_name": "R&D",
        "status": "active",
        "created_at": "2026-06-10T04:27:06.313Z",
        "updated_at": "2026-06-10T04:27:06.313Z"
    }
}
```

#### ➤ Get Departments
```
GET /api/department/all-department
```

### Success Response
```json
{
    "success": true,
    "message": "Departments fetched successfully",
    "data": [
        {
            "id": 4,
            "department_name": "ACCOUNT",
            "status": "active",
            "created_at": "2026-06-11T10:05:56.549Z",
            "updated_at": "2026-06-12T09:53:00.058Z",
            "description": null,
            "created_by": null
        },
        {
            "id": 1,
            "department_name": "HR",
            "status": "active",
            "created_at": "2026-06-10T04:26:50.299Z",
            "updated_at": "2026-06-10T04:32:44.686Z",
            "description": null,
            "created_by": null
        }
    ]
}
```

#### ➤ Update Departments
```
PUT /api/department/update-department/:id
```

```
PUT /api/department/update-department/1
```

### Success Response
```json
{
    "success": true,
    "message": "Department updated successfully",
    "data": {
        "id": 1,
        "department_name": "HR",
        "status": "active",
        "created_at": "2026-06-10T04:26:50.299Z",
        "updated_at": "2026-06-10T04:31:35.985Z"
    }
}
```

#### ➤ Update Toggle
```
PATCH /api/department/toggle/:id
```

```
PATCH /api/department/toggle/1
```

### Success Response
```json
{
    "success": true,
    "message": "Department status updated successfully",
    "data": {
        "id": 1,
        "department_name": "HR",
        "status": "deactive",
        "created_at": "2026-06-10T04:26:50.299Z",
        "updated_at": "2026-06-13T05:22:15.368Z",
        "description": null,
        "created_by": null
    }
}
```

-----------------------------------------------------------------------------------------------------------

#### Departments Structure

#### ➤ Add Departments Structure
```
POST /api/department-structure/add-department-structure
```

### Success Response
```json
{
    "success": true,
    "message": "Department added successfully",
    "data": {
        "id": 4,
        "parent_id": 3,
        "name": "STORE",
        "description": "STORE",
        "is_active": true,
        "created_at": "2026-06-24T05:17:55.657Z",
        "updated_at": "2026-06-24T05:17:55.657Z"
    }
}
```

#### ➤ Get Departments Structure
```
GET /api/department-structure/all-department-structure
```

### Success Response
```json
{
    "success": true,
    "message": "Departments fetched successfully",
    "data": [
        {
          "id": 1,
          "parent_id": null,
          "name": "IT",
          "description": "Information Technology",
          "is_active": true,
          "created_at": "2026-06-24T05:15:13.689Z",
          "updated_at": "2026-06-24T05:31:47.842Z",
          "children": [
            {
              "id": 3,
              "parent_id": 1,
              "name": "BACKEND",
              "description": "BACKEND TEAM",
              "is_active": true,
              "created_at": "2026-06-24T05:17:22.064Z",
              "updated_at": "2026-07-02T08:54:06.144Z",
              "children": []
            }
          ]
        }
    ]
}
```

#### ➤ Get by id Departments Structure
```
GET /api/department-structure/all-department-structure/:id
```

```
GET /api/department-structure/all-department-structure/1
```

### Success Response
```json
{
  "success": true,
  "data": {
    "id": 1,
    "parent_id": null,
    "name": "IT",
    "description": "Information Technology",
    "is_active": true,
    "created_at": "2026-06-24T05:15:13.689Z",
    "updated_at": "2026-06-24T05:31:47.842Z",
    "children": [
      {
        "id": 3,
        "parent_id": 1,
        "name": "BACKEND",
        "description": "BACKEND TEAM",
        "is_active": true,
        "created_at": "2026-06-24T05:17:22.064Z",
        "updated_at": "2026-07-02T08:54:06.144Z",
        "children": []
      }
    ]
  }
}
```

#### ➤ Get by id Departments Structure
```
GET /api/department-structure/sub-departments?department=HR
```

### Success Response
```json
{
  "success": true,
  "message": "Sub departments fetched successfully",
  "data": [
    {
      "id": 33,
      "sub_department": "HR",
      "description": null,
      "is_active": true
    },
    {
      "id": 34,
      "sub_department": "HR Executive",
      "description": null,
      "is_active": true
    }
  ]
}
```

#### ➤ Update Departments Structure
```
PUT /api/department-structure/update-department-structure/:id
```

```
PUT /api/department-structure/update-department-structure/3
```

### Success Response
```json
{
    "success": true,
    "message": "Department updated successfully",
    "data": {
        "id": 3,
        "parent_id": 1,
        "name": "BACKEND",
        "description": "BACKEND TEAM",
        "is_active": true,
        "created_at": "2026-06-24T05:17:22.064Z",
        "updated_at": "2026-06-24T05:26:27.570Z"
    }
}
```

#### ➤ Update Toggle
```
PATCH /api/department-structure/toggle/:id
```

```
PATCH /api/department-structure/toggle/1
```

### Success Response
```json
{
    "success": true,
    "message": "Department deactivated successfully",
    "data": {
        "id": 1,
        "parent_id": null,
        "name": "IT",
        "description": "Information Technology",
        "is_active": false,
        "created_at": "2026-06-24T05:15:13.689Z",
        "updated_at": "2026-07-04T09:37:59.151Z"
    }
}
```

#### ➤ Delete Departments Structure
```
DELETE /api/department-structure/delete-department-structure/:id
```

```
DELETE /api/department-structure/delete-department-structure/7
```

### Success Response
```json
{
    "success": true,
    "message": "Department deleted successfully",
    "data": {
        "id": 7,
        "parent_id": null,
        "name": "dewd",
        "description": "wesa",
        "is_active": true,
        "created_at": "2026-06-24T11:45:30.213Z",
        "updated_at": "2026-06-24T11:45:30.213Z"
    }
}
```

#### ➤ Get active work emails
```
GET /api/department-structure/active-work-emails
```

### Success Response
```json
{
  "success": true,
  "message": "Active users work emails fetched successfully",
  "count": 21,
  "online_users": 0,
  "offline_count": 29,
  "data": [
    {
      "department_id": 29,
      "department_name": "CEO",
      "users": [
        {
          "username": "GNV",
          "name": "GHANSHYAM NANJIBHAI VAGHASIYA",
          "first_name": "GHANSHYAM",
          "middle_name": "NANJIBHAI",
          "last_name": "VAGHASIYA",
          "image": "https://res.cloudinary.com/deurzzaeh/image/upload/v1782994465/employee_details/GNV/GHANSHYAM.webp",
          "company_mobile_number": null,
          "employment_id": null,
          "department_id": 29,
          "department": "CEO",
          "designation_id": null,
          "designation": null,
          "work_email": "VAGHASIYA_GHANSHYAM1@gtu.edu.in",
          "work_location": "ACDC TECH",
          "status": "offline"
        }
      ]
    },
    {
      "department_id": 30,
      "department_name": "COO",
      "users": [
        {
          "username": "JDB",
          "name": "JAYDEEP DINESHBHAI BHADANI",
          "first_name": "JAYDEEP",
          "middle_name": "DINESHBHAI",
          "last_name": "BHADANI",
          "image": "https://res.cloudinary.com/deurzzaeh/image/upload/v1782994613/employee_details/JDB/JAYDEEP.webp",
          "company_mobile_number": null,
          "employment_id": null,
          "department_id": 30,
          "department": "COO",
          "designation_id": null,
          "designation": null,
          "work_email": "BHADANI_JAYDEEP@gtu.edu.in",
          "work_location": "ACDC TECH",
          "status": "offline"
        }
      ]
    },
    ]
}
```

#### ➤ Open employee Google Chat
```
GET /api/department-structure/open-employee-google-chat/:username
```

### Success Response
```json
{
  "success": true,
  "message": "Monthly birthday and wedding anniversary list fetched successfully",
  "month": 11,
  "year": 2026,
  "work_location": [],
  "total_birthdays": 2,
  "total_anniversaries": 0,
  "total": 2,
  "data": [
    {
      "personal_details_id": 11,
      "username": "JRS",
      "first_name": "JAYDEEP",
      "middle_name": "RAJUBHAI",
      "last_name": "SONDIGARA",
      "birthday_date": "2003-11-01",
      "is_birthday": true,
      "age": 23,
      "employment_id": "EMA0400426",
      "anniversary_date": null,
      "is_anniversary": false,
      "anniversary_years": null,
      "celebration_types": [
        "Birthday"
      ],
      "work_email": "acdc.engineer16@gmail.com",
      "department_id": 1,
      "department": "EMBEDDED ENGINEER",
      "designation_id": 14,
      "designation": "Jr. Embedded Hardware Engineer",
      "work_location_id": 1,
      "work_location": "ACDC TECH",
      "employee_status": "active"
    },
    {
      "personal_details_id": 14,
      "username": "JMD",
      "first_name": "JAYSHREE",
      "middle_name": "MUKESHBHAI",
      "last_name": "DER",
      "birthday_date": "2002-11-03",
      "is_birthday": true,
      "age": 24,
      "employment_id": "EMA0070126",
      "anniversary_date": null,
      "is_anniversary": false,
      "anniversary_years": null,
      "celebration_types": [
        "Birthday"
      ],
      "work_email": "acdc.engineer15@gmail.com",
      "department_id": 47,
      "department": "R&D",
      "designation_id": 14,
      "designation": "Jr. Embedded Hardware Engineer",
      "work_location_id": 1,
      "work_location": "ACDC TECH",
      "employee_status": "active"
    }
  ]
}
```

-----------------------------------------------------------------------------------------------------------

#### Category

#### ➤ Add Category
```
POST /api/category/add-category
```

### Success Response
```json
{
    "success": true,
    "message": "Category created successfully.",
    "data": {
        "id": 2,
        "category_name": "Employee",
        "is_active": true,
        "created_at": "2026-08-04T09:35:00.292Z",
        "updated_at": "2026-08-04T09:35:00.292Z"
    }
}
```

#### ➤ Get Categopry
```
GET /api/category/all-category
```

### Success Response
```json
{
    "success": true,
    "message": "Category fetched successfully",
    "data": [
        {
            "id": 5,
            "category_name": "Intern",
            "is_active": true,
            "created_at": "2026-08-10T03:51:05.059Z",
            "updated_at": "2026-08-10T11:18:35.169Z",
            "work_location": "ACDC TECH"
        },  
        {
            "id": 4,
            "category_name": "employee",
            "is_active": true,
            "created_at": "2026-08-10T03:50:59.604Z",
            "updated_at": "2026-08-10T03:50:59.604Z",
            "work_location": "EMBLEPCB"
        }
    ]
}
```

#### ➤ Update Departments Structure
```
PUT /api/category/update-category/:id
```

```
PUT /api/category/update-category/1
```

### Success Response
```json
{
    "success": true,
    "message": "Category updated successfully.",
    "data": {
        "id": 1,
        "category_name": "Intern",
        "created_at": "2026-08-04T09:24:58.516Z",
        "updated_at": "2026-08-04T09:24:58.516Z"
    }
}
```

#### ➤ Update Toggle
```
PATCH /api/category/toggle/:id
```

```
PATCH /api/category/toggle/1
```

### Success Response
```json
{
    "success": true,
    "message": "Category deactivated successfully.",
    "data": {
        "id": 1,
        "category_name": "Employee",
        "is_active": false,
        "created_at": "2026-08-04T09:35:00.292Z",
        "updated_at": "2026-08-04T09:36:55.186Z"
    }
}
```

#### ➤ Get employee required field names
```
GET /api/category/employee-required-field-names
```

### Success Response
```json
{
    "success": true,
    "message": "Employee required field names fetched successfully",
    "data": [
        "first_name",
        "last_name",
        "date_of_birth",
        "mobile_number"
    ]
}
```

-----------------------------------------------------------------------------------------------------------

#### Education

#### ➤ Add Category
```
POST /api/education/add-education
```

### Success Response
```json
{
    "success": true,
    "message": "Education created successfully.",
    "data": {
        "id": 2,
        "education_name": "SSH",
        "is_active": true,
        "created_at": "2026-08-04T09:45:00.391Z",
        "updated_at": "2026-08-04T09:45:00.391Z"
    }
}
```

#### ➤ Get Categopry
```
GET /api/education/all-education
```

### Success Response
```json
{
    "success": true,
    "message": "Education fetched successfully",
    "data": [
        {
            "id": 8,
            "education_name": "BCA",
            "is_active": true,
            "created_at": "2026-08-10T10:30:52.982Z",
            "updated_at": "2026-08-10T10:30:52.982Z",
            "work_location": "EMBLEPCB"
        },  
        {   
            "id": 7,
            "education_name": "BCA",
            "is_active": true,
            "created_at": "2026-08-10T10:30:45.439Z",
            "updated_at": "2026-08-10T10:30:45.439Z",
            "work_location": "ACDC TECH"
        }
    ]
}
```

#### ➤ Update Departments Structure
```
PUT /api/education/update-education/:id
```

```
PUT /api/education/update-education/1
```

### Success Response
```json
{
    "success": true,
    "message": "Education updated successfully.",
    "data": {
        "id": 1,
        "education_name": "HSC",
        "is_active": true,
        "created_at": "2026-08-04T09:45:00.391Z",
        "updated_at": "2026-08-04T09:47:36.262Z"
    }
}
```

#### ➤ Update Toggle
```
PATCH /api/education/toggle/:id
```

```
PATCH /api/education/toggle/1
```

### Success Response
```json
{
    "success": true,
    "message": "Education activated successfully.",
    "data": {
        "id": 1,
        "education_name": "HSC",
        "is_active": true,
        "created_at": "2026-08-04T09:45:00.391Z",
        "updated_at": "2026-08-04T09:48:54.706Z"
    }
}
```

-----------------------------------------------------------------------------------------------------------

#### Leave Setting

#### ➤ Add Leave Reason
```
POST /api/leave
```

```json
{
    "leave_reason": "Sick Leave",
    "status": true
}
```

### Success Response
```json
{
    "success": true,
    "message": "Leave created successfully",
    "data": {
        "id": 1,
        "leave_reason": "Sick Leave",
        "status": true
    }
}
```

#### ➤ Get All Leave Reasons
```
GET /api/leave
```

### Success Response
```json
{
    "success": true,
    "count": 2,
    "data": [
        {
            "id": 1,
            "leave_reason": "Sick Leave",
            "status": true
        },
        {
            "id": 2,
            "leave_reason": "Casual Leave",
            "status": true
        }
    ]
}
```

#### ➤ Get Leave Reason Usage
```
GET /api/leave/user-leave?view=monthly&month=10&year=2026
```

Query:
- `view` = `monthly` | `yearly`
- yearly: `yearly_filter=joining_date|financial_year`, `year` or `financial_year`
- optional: `leave_reason`, `work_location`, `department`, `name`

### Success Response
```json
{
    "success": true,
    "message": "Leave reason usage fetched successfully",
    "filters": {
        "leave_reason": null,
        "work_location": null,
        "department": null,
        "name": null
    },
    "data": []
}
```

#### ➤ Get Leave Reason By Id
```
GET /api/leave/:id
```

```
GET /api/leave/1
```

### Success Response
```json
{
    "success": true,
    "data": {
        "id": 1,
        "leave_reason": "Sick Leave",
        "status": true
    }
}
```

#### ➤ Update Leave Reason
```
PUT /api/leave/:id
```

```
PUT /api/leave/1
```

```json
{
    "leave_reason": "Medical Leave",
    "status": true
}
```

### Success Response
```json
{
    "success": true,
    "message": "Leave updated successfully",
    "data": {
        "id": 1,
        "leave_reason": "Medical Leave",
        "status": true
    }
}
```

#### ➤ Update Toggle
```
PATCH /api/leave/toggle/:id
```

```
PATCH /api/leave/toggle/1
```

### Success Response
```json
{
    "success": true,
    "message": "Leave status changed to inactive",
    "data": {
        "id": 1,
        "leave_reason": "Medical Leave",
        "status": false
    }
}
```

-----------------------------------------------------------------------------------------------------------

#### Leave Prior Days

#### ➤ Get Leave Prior
```
GET /api/leave-prior
```

### Success Response
```json
{
    "success": true,
    "message": "Leave prior settings fetched successfully",
    "data": [
        {
            "id": 1,
            "prior_days_required": 2
        }
    ]
}
```

#### ➤ Update Leave Prior Days
```
PATCH /api/leave-prior/:id
```

```
PATCH /api/leave-prior/1
```

```json
{
    "prior_days_required": 2
}
```

### Success Response
```json
{
    "success": true,
    "message": "Leave prior days updated successfully",
    "data": {
        "id": 1,
        "prior_days_required": 2
    }
}
```

-----------------------------------------------------------------------------------------------------------

#### Master Password

#### ➤ Add Master Password
```
POST /api/master-password/initialize-master-password
```

### Success Response
```json
{
    "success": true,
    "message": "Master password created successfully",
    "data": {
        "id": 6,
        "created_by": null,
        "created_at": "2026-08-11T12:30:54.718Z",
        "secret_key": "68PD 2ALA RM89 Q1A2"
    }
}
```

#### ➤ Send Mail
```
POST /api/master-password/send-mail
```

### Success Response
```json
{
    "success": true,
    "message": "OTP sent successfully.",
    "data": {
        "username": "TMM",
        "email": "acdc.it02@gmail.com",
        "access": 1,
        "expires_in": 60
    },
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJlbWFpbCI6ImFjZGMuaXQwMkBnbWFpbC5jb20iLCJvdHAiOiI2MTcyNDUiLCJwZXJzb25hbElkIjoxMiwiaWF0IjoxNzg2NDUxOTY2LCJleHAiOjE3ODY0NTIwMjZ9.WFv63pC3IuC_-GXg_RrwoxHWH4MtplNmrnQB4cGcw3E"
}
```

#### ➤ Match Secret Key
```
POST /api/master-password/match-secret-key
```

### Success Response
```json
{
    "success": true,
    "message": "Secret key matched successfully",
    "data": {
        "id": 7,
        "created_by": "TMM",
        "created_at": "2026-08-11T12:41:54.386Z",
        "updated_at": "2026-08-11T12:41:54.386Z"
    }
}
```

#### ➤ Reset Master Password
```
POST /api/master-password/reset-master-password
```

### Success Response
```json
{
    "success": true,
    "message": "Master password reset successfully",
    "data": {
        "id": 7,
        "created_by": "TMM",
        "created_at": "2026-08-11T12:41:54.386Z",
        "updated_at": "2026-08-11T12:48:40.430Z"
    }
}
```

#### ➤ Reset Secret Key
```
POST /api/master-password/reset-secret-key
```

### Success Response
```json
{
    "success": true,
    "message": "Secret key reset successfully",
    "data": {
        "id": 7,
        "created_by": "TMM",
        "created_at": "2026-08-11T12:41:54.386Z",
        "updated_at": "2026-08-14T11:42:56.111Z",
        "secret_key": "KWH6 ARFC SKQO 0IMH",
        "token": "c44c75cd8980018c382a4b5dedb120df2a50bdb0e44c564aa9d9aa61b50a4ca8"
    }
}
```

#### ➤ Get Master Password
```
GET /api/master-password/
```

### Success Response
```json
{
  "success": true,
  "message": "Master password details fetched successfully",
  "data": {
    "id": 8,
    "created_by": "TMM",
    "created_at": "2026-08-14T17:24:13.149037",
    "updated_at": "2026-08-14T17:39:14.300635",
    "is_configured": true,
    "admins": [
      {
        "username": "TMM",
        "work_email": "acdc.it02@gmail.com"
      }
    ]
  }
}
```

-----------------------------------------------------------------------------------------------------------

#### Set Password

#### ➤ Add Password
```
POST /api/auth/set-password
```

### Success Response
```json
{
    "success": true,
    "message": "Password set successfully."
}
```

#### ➤ Send OTP
```
POST /api/auth/request-reset
```

### Success Response
```json
{
    "success": true,
    "message": "OTP sent successfully.",
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJlbWFpbCI6ImFjZGMuaXQwM0BnbWFpbC5jb20iLCJvdHAiOiI4NzYzNjgiLCJwZXJzb25hbElkIjo1LCJpYXQiOjE3ODYwOTM2MjcsImV4cCI6MTc4NjA5MzY4N30.Xqi6PHlJS7MkfvDN0uSaVA9dkD-pK-Ld7iPY4WYG8gg"
}
```

#### ➤ Resend OTP
```
POST /api/auth/resend-otp
```

### Success Response
```json
{
    "success": true,
    "message": "OTP resent successfully.",
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJlbWFpbCI6ImFjZGMuaXQwM0BnbWFpbC5jb20iLCJvdHAiOiIzMjQzNDciLCJwZXJzb25hbElkIjo1LCJpYXQiOjE3ODYwMTcxNzQsImV4cCI6MTc4NjAxNzIzNH0.yhPHqyoh-6I4nTOIa8Z6Fy-KtE7H1c_tcZ5jmlkSGkE"
}
```

#### ➤ Verify OTP
```
POST /api/auth/verify-otp
```

### Success Response
```json
{
    "success": true,
    "message": "OTP verified successfully."
}
```

#### ➤ Reset Password
```
POST /api/auth/reset-password
```

### Success Response
```json
{
    "success": true,
    "message": "Password reset successful."
}
```

#### ➤ Get Master Password
```
GET /api/auth/test-token
```

### Success Response
```json
{
    "success": false,
    "message": "personalId is required."
}
```

-----------------------------------------------------------------------------------------------------------

#### Devices Configuration

#### ➤ Add Device Configuration
```
POST /api/device-configuration/add-device-configuration
```

### Success Response
```json
{
    "success": true,
    "message": "Device configuration added successfully",
    "data": {
        "id": 1,
        "device_id": "01",
        "mac_id": "14335C698625",
        "location": "ACDC TECH",
        "department": "IT",
        "connection": "online",
        "device_name": "ACDC TECH/IT/01",
        "created_by": null,
        "status": true,
        "created_at": "2026-06-12T10:55:58.057Z",
        "updated_at": "2026-06-12T10:55:58.057Z"
    }
}
```

#### ➤ Get Device Configuration
```
GET /api/device-configuration/all-device-configuration
```

### Success Response
```json
{
    "success": true,
    "message": "Device configurations fetched successfully",
    "data": [
        {
            "id": 1,
            "device_id": "01",
            "mac_id": "14335C698625",
            "location": "ACDC TECH",
            "department": "IT",
            "connection": "offline",
            "device_name": "ACDC TECH/IT/01",
            "created_by": null,
            "status": false,
            "created_at": "2026-06-12T10:55:58.057Z",
            "updated_at": "2026-06-12T11:16:50.664Z"
        },
        {
            "id": 2,
            "device_id": "01",
            "mac_id": "14335C698624",
            "location": "ACDCTECH",
            "department": "ACCOUNT",
            "connection": "online",
            "device_name": "ACDCTECH/ACCOUNT/01",
            "created_by": null,
            "status": true,
            "created_at": "2026-06-12T11:05:57.206Z",
            "updated_at": "2026-06-12T11:17:07.663Z"
        }
    ]
}
```

#### ➤ Update Device Configuration
```
PUT /api/device-configuration/update-device-configuration/:id
```

```
PUT /api/device-configuration/update-device-configuration/1
```

### Success Response
```json
{
    "success": true,
    "message": "Device configuration updated successfully",
    "data": {
        "id": 1,
        "device_id": "01",
        "mac_id": "14335C698625",
        "location": "ACDC TECH",
        "department": "IT",
        "connection": "offline",
        "device_name": "ACDC TECH/IT/01",
        "created_by": null,
        "status": false,
        "created_at": "2026-06-12T10:55:58.057Z",
        "updated_at": "2026-06-12T11:16:50.664Z"
    }
}
```

#### ➤ Update Toggle
```
PATCH /api/device-configuration/toggle/:id
```

```
PATCH /api/device-configuration/toggle/1
```

### Success Response
```json
{
    "success": true,
    "message": "Device status updated successfully",
    "data": {
        "id": 1,
        "device_name": "Main Gate Device",
        "mac_id": "00:1A:2B:3C:4D:5E",
        "work_location": "ACDC TECH",
        "department": "IT",
        "status": "active",
        "created_at": "2026-06-10T04:53:33.772Z",
        "updated_at": "2026-06-10T04:57:46.751Z"
    }
}
```

#### ➤ Open device by MAC
```
GET /api/device-configuration/open-mac-address/:mac_id
```

```
GET /api/device-configuration/open-mac-address/14335C698624
```

### Success Response
```json
{
    "success": true,
    "message": "Device details fetched successfully",
    "data": {
        "id": 1,
        "device_name": "Main Gate Device",
        "mac_id": "14335C698624",
        "work_location": "ACDC TECH",
        "department": "IT",
        "status": "active"
    }
}
```

-----------------------------------------------------------------------------------------------------------

#### Attendance Session

#### Add Attendance Seesion
```
POST    /api/attendance-session/add-attendance-session
```

```json
{
    "success": true,
    "message": "Attendance exit recorded successfully",
    "data": {
        "id": 35,
        "rfid": "0001110928",
        "mac_id": "28562F5A95C8",
        "entry_at": "2026-06-19T07:00:00.000Z",
        "exit_at": "2026-06-19T07:00:00.000Z",
        "entry_message_id": 387232,
        "exit_message_id": 387232,
        "status": "completed",
        "created_at": "2026-06-19T07:09:23.051Z",
        "updated_at": "2026-06-19T07:09:39.918Z"
    }
}
```

#### ➤ Get Attendance Session
```
GET    /api/attendance-session/all-attendance-session
```

### Success Response
```json
{
    "success": true,
    "message": "Attendance sessions fetched successfully",
    "data": [
        {
            "id": 38,
            "rfid": "0005062127",
            "mac_id": "28562F5A95C8",
            "entry_at": "2026-06-19T09:12:23.000Z",
            "exit_at": "2026-06-19T09:12:32.000Z",
            "entry_message_id": 618339,
            "exit_message_id": 255516,
            "status": "completed",
            "created_at": "2026-06-19T09:12:23.371Z",
            "updated_at": "2026-06-19T09:12:32.192Z",
            "username": "UNREGISTERED",
            "duration": {
                "seconds": 9
            }
        },
        {
            "id": 37,
            "rfid": "0001110928",
            "mac_id": "28562F5A95C8",
            "entry_at": "2026-06-19T09:07:10.000Z",
            "exit_at": "2026-06-19T09:07:23.000Z",
            "entry_message_id": 989902,
            "exit_message_id": 652481,
            "status": "completed",
            "created_at": "2026-06-19T09:07:10.587Z",
            "updated_at": "2026-06-19T09:07:23.663Z",
            "username": "AAM",
            "duration": {
                "seconds": 13
            }
        }
    ]
}
```

#### ➤ Get Attendance Session
```
GET    /api/attendance-session/all-attendance-sessions
```

### Success Response
```json
{
  "success": true,
  "message": "Attendance sessions fetched successfully",
  "data": [
        {
          "id": 581,
          "rfid": "0001799948",
          "username": "TKA",
          "entry_mac_id": "14335C698624",
          "exit_mac_id": "AUTO",
          "entry_device_name": "ACDC TECH/IT/02",
          "exit_device_name": "AUTO",
          "entry_at": "2026-08-01T10:43:47.000Z",
          "exit_at": null,
          "duration": null,
          "entry_message_id": 748247,
          "exit_message_id": null,
          "status": "expired",
          "created_at": "2026-08-01T10:43:47.477Z",
          "updated_at": "2026-08-03T04:13:00.031Z",
          "first_name": "TANVI",
          "middle_name": "KIRITBHAI",
          "last_name": "AMIPARA",
          "employee_username": "TKA",
          "employment_id": "EMA0060925",
          "shift_type": "Morning",
          "work_location": "ACDC TECH",
          "shift_time": "09:00 - 18:30",
          "employee_status": "active"
        },
        {
          "id": 580,
          "rfid": "0004628118",
          "username": "HGG",
          "entry_mac_id": "14335C698624",
          "exit_mac_id": "AUTO",
          "entry_device_name": "ACDC TECH/IT/02",
          "exit_device_name": "AUTO",
          "entry_at": "2026-08-01T10:30:05.000Z",
          "exit_at": null,
          "duration": null,
          "entry_message_id": 456682,
          "exit_message_id": null,
          "status": "expired",
          "created_at": "2026-08-01T10:30:04.892Z",
          "updated_at": "2026-08-03T04:13:00.012Z",
          "first_name": "TEST",
          "middle_name": "USER",
          "last_name": "ACDC",
          "employee_username": "TST",
          "employment_id": "EMA0160726",
          "shift_type": "Morning",
          "work_location": "ACDC TECH",
          "shift_time": "09:00 - 18:30",
          "employee_status": "active"
        }
    ]
}
```

#### ➤ Get username Attendance Session
```
GET    /api/attendance-session/attendance-by-username
```

### Success Response
```json
{
    "success": true,
    "message": "Attendance fetched successfully",
    "data": [
        {
            "username": "AAM",
            "first_name": "ARYAN",
            "middle_name": "ASHVINBHAI",
            "last_name": "MENDAPARA",
            "full_name": "ARYAN ASHVINBHAI MENDAPARA (AAM)",
            "employment_id": "EMA0020426",
            "shift_type": "Morning",
            "shift_time": null,
            "work_location": "ACDC TECH",
            "image": "https://res.cloudinary.com/deurzzaeh/image/upload/v1782993599/employee/AAM/ARYAN.webp",
            "entries": []
        },  
        {   
            "username": "ABD",
            "first_name": "AMI",
            "middle_name": null,
            "last_name": null,
            "full_name": "AMI (ABD)",
            "employment_id": "EMA0030726",
            "shift_type": null,
            "shift_time": null,
            "work_location": "ACDC TECH",
            "image": null,
            "entries": []
        }
    ]
}
```

#### ➤ Get Attendance Session by username
```
GET    /api/attendance-session/username/:username
```

```
GET    /api/attendance-session/username/AAM
```

### Success Response
```json
{
    "success": true,
    "message": "Attendance sessions fetched successfully",
    "data": [
        {
        "date": "03-07-2026",
        "shift_type": "Morning",
        "shift_time": null,
        "work_location": "ACDC TECH",
        "entries": [
                {
                    "id": 94,
                    "entry_at": "03-07-2026 15:07:48",
                    "exit_at": null,
                    "duration": null,
                    "status": "inside",
                    "entry_device_name": "ACDC TECH/IT/02",
                    "exit_device_name": null
                },  
                {   
                    "id": 93,
                    "entry_at": "03-07-2026 15:04:36",
                    "exit_at": "03-07-2026 15:05:38",
                    "duration": {
                      "minutes": 1,
                      "seconds": 2
                    },
                    "status": "completed",
                    "entry_device_name": "ACDC TECH/IT/02",
                    "exit_device_name": "ACDC TECH/IT/02"
                }
            ]
        }
    ]
}
```

#### ➤ Update Attendance Session
```
PATCH    api/attendance-session/edit-attendance-session/:id
```

```
PATCH    api/attendance-session/edit-attendance-session/14
```

### Success Response
```json
{
    "success": true,
    "message": "Attendance session updated successfully",
    "data": {
        "id": 14,
        "rfid": "0001110928",
        "username": "AAM",
        "mac_id": "28562F5A95C8",
        "entry_at": "2026-06-25T03:30:00.000Z",
        "exit_at": "2026-06-25T04:30:00.000Z",
        "duration": {
            "hours": 1
        },
        "entry_message_id": 896711,
        "exit_message_id": null,
        "status": "completed",
        "created_at": "2026-06-25T04:07:55.017Z",
        "updated_at": "2026-06-25T04:15:46.328Z"
    }
}
```

#### ➤ Delete Attendance Session
```
DELETE    api/attendance-session/delete-attendance-session/:id
```

```
DELETE    api/attendance-session/delete-attendance-session/37
```

### Success Response
```json
{
    "success": true,
    "message": "Attendance session deleted successfully",
    "data": {
        "id": 37,
        "rfid": "0004628118",
        "username": "SJA",
        "mac_id": "28562F5A95C8",
        "entry_at": "2026-06-25T06:10:25.000Z",
        "exit_at": "2026-06-25T06:10:28.000Z",
        "duration": {
            "seconds": 3
        },
        "entry_message_id": 700729,
        "exit_message_id": 443721,
        "status": "completed",
        "created_at": "2026-06-25T06:10:25.401Z",
        "updated_at": "2026-06-25T06:10:27.812Z"
    }
}
```

-----------------------------------------------------------------------------------------------------------

#### Holiday

#### ➤ Add Holiday
```
POST   /api/holiday/add-holiday
```

### Success Response
```json
{
    "success": true,
    "message": "Holiday created successfully",
    "data": {
        "id": 5,
        "holiday_name": "Independence Day",
        "holiday_date": "2026-06-30",
        "locations": [
            "Surat",
            "Ahmedabad"
        ],
        "created_by": "admin",
        "created_at": "2026-06-29T04:09:09.573Z",
        "updated_at": "2026-06-29T04:09:09.573Z"
    }
}
```

#### ➤ Get Holiday
```
GET   /api/holiday/all-holiday
```

### Success Response
```json
{
    "success": true,
    "message": "Holiday fetched successfully",
    "data": [
        {
          "id": 6,
          "holiday_name": "Bank Holiday",
          "holiday_date": "2026-06-04",
          "locations": [
            "ACDC TECH"
          ],
          "created_by": null,
          "created_at": "2026-06-29T04:12:33.112Z",
          "updated_at": "2026-06-29T04:12:33.112Z"
        },
        {
          "id": 9,
          "holiday_name": "Diwali",
          "holiday_date": "2026-06-26",
          "locations": [
            "ACDC TECH",
            "EMBLEPCB"
          ],
          "created_by": null,
          "created_at": "2026-06-29T04:26:43.968Z",
          "updated_at": "2026-06-29T04:26:43.968Z"
        }
    ]
}
```

#### ➤ Get Holiday in calendar
```
GET   /api/holiday/calendar?year=2026&month=6
```

### Success Response
```json
{
    "success": true,
    "data": {
        "month": 6,
        "year": 2026,
        "calendar": [
          {
            "date": "2026-06-01",
            "day": 1,
            "dayName": "Mon",
            "isCurrentMonth": true,
            "isToday": false,
            "holiday": null,
            "leaves": []
          },
          {
            "date": "2026-06-02",
            "day": 2,
            "dayName": "Tue",
            "isCurrentMonth": true,
            "isToday": false,
            "holiday": null,
            "leaves": []
          }
        ]
    }
}
```

#### ➤ Get username in Holiday
```
GET   /api/holiday/username/:username
```

```
GET   /api/holiday/username/AAM
```

### Success Response
```json
{
    "success": true,
    "message": "Holidays fetched successfully",
    "data": [
        {
          "id": 5,
          "holiday_name": "Makar Sankranti",
          "holiday_date": "2026-01-14",
          "transfer_date": null,
          "locations": [
            "ACDC TECH"
          ],
          "work_location": "ACDC TECH",
          "location_id": 1,
          "created_by": null,
          "created_at": "2026-07-14T11:07:06.983Z",
          "updated_at": "2026-07-14T11:07:06.983Z"
        },
    ]
}
```

#### ➤ Update Holiday
```
PUT   /api/holiday/update-holiday/:id
```

```
PUT   /api/holiday/update-holiday/1
```

### Success Response
```json
{
    "success": true,
    "message": "Holiday updated successfully",
    "data": {
        "id": 1,
        "holiday_name": "Independence Day",
        "holiday_date": "2026-08-14T18:30:00.000Z",
        "locations": [
            "Surat"
        ],
        "created_by": "admin",
        "created_at": "2026-06-27T12:06:39.184Z",
        "updated_at": "2026-06-27T12:12:54.670Z"
    }
}
```

#### ➤ Put transfer Holiday
```
PUT   /api/holiday/transfer-holiday/:id
```

```
PUT   /api/holiday/transfer-holiday/3
```

### Success Response
```json
{
    "success": true,
    "message": "Holiday transferred successfully",
    "data": {
        "id": 3,
        "holiday_name": "Independence ",
        "holiday_date": "2026-07-12",
        "locations": [
            "Surat",
            "Ahmedabad"
        ],
        "created_by": "admin",
        "created_at": "2026-06-29T04:08:25.573Z",
        "updated_at": "2026-07-10T10:19:58.973Z"
    }
}
```

#### ➤ Delete Holiday
```
DELETE   /api/holiday/delete-holiday/:id
```

```
DELETE   /api/holiday/delete-holiday/1
```

### Success Response
```json
{
    "success": true,
    "message": "Holiday deleted successfully",
    "data": {
        "id": 1,
        "holiday_name": "Independence Day",
        "holiday_date": "2026-08-14T18:30:00.000Z",
        "locations": [
            "Surat"
        ],
        "created_by": "admin",
        "created_at": "2026-06-27T12:06:39.184Z",
        "updated_at": "2026-06-27T12:12:54.670Z"
    }
}
```

#### ➤ Get calendar by username
```
GET /api/holiday/calendar/:username
```

```
GET /api/holiday/calendar/AAM
```

### Success Response
```json
{
    "success": true,
    "message": "Holiday calendar fetched successfully",
    "data": [
        {
            "holiday_name": "Independence Day",
            "holiday_date": "2026-08-15",
            "locations": ["ACDC TECH"]
        }
    ]
}
```

#### ➤ Get upcoming holidays
```
GET /api/holiday/upcoming-holidays
```

### Success Response
```json
{
    "success": true,
    "message": "Upcoming holidays fetched successfully",
    "data": [
        {
            "id": 8,
            "holiday_name": "Diwali",
            "holiday_date": "2026-11-08",
            "locations": ["ACDC TECH"]
        }
    ]
}
```

-----------------------------------------------------------------------------------------------------------

#### Employee Record

#### ➤ Get Yearly Employee Record
```
GET   /api/employee-record/all-employee-yearly-record?year=2026
```

### Success Response
```json
{
  "success": true,
  "message": "Yearly attendance fetched successfully",
  "data": [
    {
        "employment_id": null,
        "username": "ADP",
        "first_name": "",
        "middle_name": null,
        "last_name": null,
        "employee_name": "",
        "image": null,
        "months": [
            {
              "month": "January",
              "present": 0,
              "absent": 31,
              "half_day": 0,
              "company_holiday": 0,
              "total_hours": "0.00 h",
              "total_minutes": 0,
              "attendance_percentage": "0.00%"
            },
            {
              "month": "February",
              "present": 0,
              "absent": 28,
              "half_day": 0,
              "company_holiday": 0,
              "total_hours": "0.00 h",
              "total_minutes": 0,
              "attendance_percentage": "0.00%"
            }
        ]
    }
  ]
}
```

#### ➤ Get Employee Record
```
GET   /api/employee-record/all-employee-record?from=2026-07-02&to=2026-07-10
```

### Success Response
```json
{
  "success": true,
  "data": [
    {
      "employment_id": null,
      "username": "ADP",
      "first_name": "",
      "middle_name": null,
      "last_name": null,
      "employee_name": "",
      "image": null,
      "attendance": {
        "2026-07-02": "A",
        "2026-07-03": "A",
        "2026-07-04": "NM",
        "2026-07-05": "NM",
        "2026-07-06": "NM",
        "2026-07-07": "NM",
        "2026-07-08": "NM",
        "2026-07-09": "NM",
        "2026-07-10": "NM"
      }
    }
  ]
}
```

#### ➤ Get Employee record by username
```
GET /api/employee-record/username/:username?from=2026-06-29&to=2026-07-01
```

Example:
```
GET /api/employee-record/username/AAM?from=2026-06-29&to=2026-07-01
```

### Success Response
```json
{
  "success": true,
  "data": [
    {
      "employment_id": "EMA0020426",
      "username": "AAM",
      "first_name": "ARYAN",
      "middle_name": "ASHVINBHAI",
      "last_name": "MENDAPARA",
      "employee_name": "ARYAN ASHVINBHAI MENDAPARA",
      "image": "https://res.cloudinary.com/deurzzaeh/image/upload/v1782993599/employee/AAM/ARYAN.webp",
      "attendance": {
        "2026-06-29": "P",
        "2026-06-30": "P",
        "2026-07-01": "P"
      }
    }
  ]
}
```

-----------------------------------------------------------------------------------------------------------

#### Employee Leave

#### ➤ Add Employee Leave
```
POST   /api/employee-leave/add-leave
```

### Success Response
```json
{
    "success": true,
    "message": "Leave added successfully",
    "data": {
        "id": 5,
        "username": "ABD",
        "start_leave_date": "2026-07-04",
        "end_leave_date": "2026-07-04",
        "reason": "Medical Leave",
        "created_at": "2026-07-02T11:02:25.189Z",
        "updated_at": "2026-07-02T11:02:25.189Z"
    }
}
```

#### ➤ Get All Leave
```
GET   /api/employee-leave/all-leave
```

### Success Response
```json
{
  "success": true,
  "data": [
    {
      "id": 8,
      "username": "SJA",
    "start_leave_date": "2026-07-03",
    "end_leave_date": "2026-07-03",
      "reason": "Eserytth",
      "created_at": "2026-07-03T06:23:20.299Z",
      "updated_at": "2026-07-03T06:23:20.299Z"
    },
    {
      "id": 12,
      "username": "TMM",
    "start_leave_date": "2026-07-03",
    "end_leave_date": "2026-07-03",
      "reason": "",
      "created_at": "2026-07-03T06:53:19.912Z",
      "updated_at": "2026-07-03T06:53:19.912Z"
    }
  ]
}
```

#### ➤ Update Employee Leave
```
PUT   /api/employee-leave/update-leave/:id
```

```
PUT   /api/employee-leave/update-leave/1
```

### Success Response
```json
{
    "success": true,
    "message": "Leave updated successfully",
    "data": {
        "id": 1,
        "username": "AAM",
        "start_leave_date": "2026-07-08",
        "end_leave_date": "2026-07-10",
        "reason": "Medical Leave",
        "created_at": "2026-07-02T11:01:13.544Z",
        "updated_at": "2026-07-02T11:01:41.380Z"
    }
}
```

#### ➤ Delete Employee Leave
```
GET   /api/employee-leave/delete-leave/:id
```

```
GET   /api/employee-leave/delete-leave/4
```

### Success Response
```json
{
    "success": true,
    "message": "Leave deleted successfully",
    "data": {
        "id": 4,
        "username": "ABD",
        "start_leave_date": "2026-07-04",
        "end_leave_date": "2026-07-04",
        "reason": "Medical Leave",
        "created_at": "2026-07-02T11:02:25.189Z",
        "updated_at": "2026-07-02T11:02:25.189Z"
    }
}
```

#### ➤ Get leave by id
```
GET /api/employee-leave/leave/:id
```

```
GET /api/employee-leave/leave/4
```

### Success Response
```json
{
    "success": true,
    "data": {
        "id": 4,
        "username": "ABD",
        "start_leave_date": "2026-07-04",
        "end_leave_date": "2026-07-04",
        "reason": "Medical Leave",
        "status": "Approved"
    }
}
```

#### ➤ Get leave calendar
```
GET /api/employee-leave/calendar?year=2026&month=10
```

### Success Response
```json
{
    "success": true,
    "message": "Leave calendar fetched successfully",
    "data": []
}
```

#### ➤ Get today leave
```
GET /api/employee-leave/today-leave
```

### Success Response
```json
{
    "success": true,
    "message": "Today leave fetched successfully",
    "count": 1,
    "data": [
        {
            "username": "AAM",
            "reason": "Medical Leave",
            "start_leave_date": "2026-10-17",
            "end_leave_date": "2026-10-17"
        }
    ]
}
```

#### ➤ Get upcoming leaves
```
GET /api/employee-leave/upcoming
```

### Success Response
```json
{
    "success": true,
    "message": "Upcoming leaves fetched successfully",
    "data": []
}
```

#### ➤ Get leave status counts
```
GET /api/employee-leave/status-counts
```

### Success Response
```json
{
    "success": true,
    "data": {
        "pending": 3,
        "approved": 7,
        "rejected": 1
    }
}
```

#### ➤ Get pending leave count
```
GET /api/employee-leave/pending-leave-count
```

### Success Response
```json
{
    "success": true,
    "count": 3
}
```

#### ➤ Delete leave
```
DELETE /api/employee-leave/delete-leave/:id
```

```
DELETE /api/employee-leave/delete-leave/4
```

### Success Response
```json
{
    "success": true,
    "message": "Leave deleted successfully",
    "data": {
        "id": 4,
        "username": "ABD"
    }
}
```

-----------------------------------------------------------------------------------------------------------

#### Summary

#### ➤ Get All Summary
```
GET   /api/summary/all-summary?month=6&year=2026
```

### Success Response
```json
{
  "success": true,
  "message": "Attendance summary fetched successfully",
  "data": [
    {
      "profile_image": null,
      "first_name": "",
      "middle_name": null,
      "last_name": null,
      "username": "ADP",
      "employee_id": null,
      "department": "CTO",
      "location": null,
      "present": 0,
      "absent": 21,
      "weekly_off": 4,
      "holiday": 5,
      "total_days": 30,
      "total_hours": "0h 00m",
      "total_minutes": 0,
      "attendance_percentage": 0
    },
    {
      "profile_image": null,
      "first_name": "AMI",
      "middle_name": null,
      "last_name": null,
      "username": "ABD",
      "employee_id": "EMA0030726",
      "department": null,
      "location": "ACDC TECH",
      "present": 0,
      "absent": 21,
      "weekly_off": 4,
      "holiday": 5,
      "total_days": 30,
      "total_hours": "0h 00m",
      "total_minutes": 0,
      "attendance_percentage": 0
    }
  ]
}
```

#### ➤ Get Summary by username
```
GET   /api/summary/username/:username
```

```
GET   /api/summary/username/AAM
```

### Success Response
```json
{
  "success": true,
  "message": "Attendance summary fetched successfully",
  "data": [
    {
      "profile_image": "https://res.cloudinary.com/deurzzaeh/image/upload/v1782993599/employee/AAM/ARYAN.webp",
      "first_name": "ARYAN",
      "middle_name": "ASHVINBHAI",
      "last_name": "MENDAPARA",
      "username": "AAM",
      "employee_id": "EMA0020426",
      "department": "IT",
      "location": "ACDC TECH",
      "present": 0,
      "absent": null,
      "weekly_off": 0,
      "holiday": 0,
      "total_days": null,
      "total_hours": "0h 00m",
      "total_minutes": 0,
      "attendance_percentage": 0
    }
  ]
}
```

-----------------------------------------------------------------------------------------------------------

#### Mac id

#### ➤ Get Mac id
```
GET /api/mac-address/mac-unregistered
```

### Success Response
```json
{
    "success": true,
    "message": "Unregistered MAC addresses fetched successfully",
    "data": [
        {
            "id": 4,
            "mac_address": "14335C698627",
            "status": "unregistered",
            "created_at": "2026-06-12T06:11:34.315Z",
            "updated_at": "2026-06-12T06:11:34.315Z"
        },
        {
            "id": 5,
            "mac_address": "14335C698628",
            "status": "unregistered",
            "created_at": "2026-06-12T06:14:27.395Z",
            "updated_at": "2026-06-12T06:14:39.052Z"
        }
    ]
}
```

-----------------------------------------------------------------------------------------------------------

#### Open Sessions

#### ➤ Get Open Sessions
```
GET /api/open-sessions/open-sessions
```

### Success Response
```json
{
    "success": true,
    "message": "Open sessions fetched successfully",
    "data": [
        {
            "id": 13,
            "rfid": "0011674414",
            "mac_id": "28562F5A95C8",
            "session_id": 21,
            "entry_at": "2026-06-17T04:32:32.000Z",
            "last_scan_at": "2026-06-17T04:32:32.000Z",
            "created_at": "2026-06-17T04:32:32.933Z"
        }
    ]
}
```

-----------------------------------------------------------------------------------------------------------

#### Mqtt Messages

#### ➤ Get Mqtt Messages
```
GET /api/mqtt-messages/all-mqtt-messages
```

### Success Response
```json
{
    "success": true,
    "message": "MQTT messages fetched successfully",
    "data": [
        {
            "id": 92,
            "mac_id": "28562F5A95C8",
            "rfid_uid": "0005062127",
            "message_id": 255516,
            "device_timestamp": "2026-06-19T09:12:32.000Z",
            "received_at": "2026-06-19T09:12:32.193Z",
            "ack_sent": true,
            "raw_payload": "{\"rfid_uid\":\"0005062127\",\"timestamp\":\"2026-06-19T09:12:32Z\",\"message_id\":255516,\"mac_address\":\"28562F5A95C8\"}"
        },
        {
            "id": 91,
            "mac_id": "28562F5A95C8",
            "rfid_uid": "0005062127",
            "message_id": 618339,
            "device_timestamp": "2026-06-19T09:12:23.000Z",
            "received_at": "2026-06-19T09:12:23.373Z",
            "ack_sent": true,
            "raw_payload": "{\"rfid_uid\":\"0005062127\",\"timestamp\":\"2026-06-19T09:12:23Z\",\"message_id\":618339,\"mac_address\":\"28562F5A95C8\"}"
        }
    ]
}
```

-----------------------------------------------------------------------------------------------------------

```
GET    /api/personal-details/all-personal-detail
GET    /api/personal-details/all-personal-detail/:id
POST   /api/personal-details/add-personal-detail
PUT    /api/personal-details/update-personal-detail/:id
```

-----------------------------------------------------------------------------------------------------------

### Employees

#### Import Employee Details

#### ➤ Add Personal Details
```
POST /api/personal-details/add-personal-detail
```

### Success Response
```json
{
  "success": true,
  "message": "Import Completed",
  "total": 20,
  "inserted": 18,
  "skipped": 2,
  "errors": [
    {
      "username": "ABC",
      "message": "Username already exists"
    }
  ]
}
```

-----------------------------------------------------------------------------------------------------------

#### Personal Details

#### ➤ Add Personal Details
```
POST /api/personal-details/add-personal-detail
```

### Success Response
```json
{
    "success": true,
    "message": "Personal details added successfully",
    "data": {
        "id": 1,
        "first_name": "Aryan",
        "middle_name": "Ashvinbhai",
        "last_name": "Mendapara",
        "username": "AAM",
        "date_of_birth": "2007-02-22T18:30:00.000Z",
        "gender": "male",
        "blood_group": "B+",
        "family_members_count": 4,
        "marital_status": "Unmarried",
        "dependent_children": 0,
        "email_id": "aam@gmail.com",
        "current_address": "surat",
        "permanent_address": "surat",
        "image": null,
        "mobile_number": "9558636610",
        "alternate_contact_number": "9558636610",
        "emergency_contact_name": "AAM",
        "emergency_contact_number": "9558636610",
        "emergency_relationship": "me",
        "created_at": "2026-06-19T08:57:20.276Z",
        "updated_at": "2026-06-19T08:57:20.276Z"
    }
}
```

#### ➤ Get Personal Details
```
GET /api/personal-details/all-personal-detail
```

### Success Response
```json
{
    "success": true,
    "message": "Personal details fetched successfully",
    "data": [
        {
            "id": 1,
            "first_name": "Aryan",
            "middle_name": "Ashvinbhai",
            "last_name": "Mendapara",
            "username": "AAM",
            "date_of_birth": "2007-02-22T18:30:00.000Z",
            "gender": "male",
            "blood_group": "B+",
            "family_members_count": 4,
            "marital_status": "Unmarried",
            "dependent_children": 0,
            "email_id": "aam@gmail.com",
            "current_address": "surat",
            "permanent_address": "surat",
            "image": null,
            "mobile_number": "9558636610",
            "alternate_contact_number": "9558636610",
            "emergency_contact_name": "AAM",
            "emergency_contact_number": "9558636610",
            "emergency_relationship": "me",
            "created_at": "2026-06-19T08:57:20.276Z",
            "updated_at": "2026-06-19T08:57:20.276Z",
            "status": null
        }
    ]
}
```

#### ➤ Get by id Personal Details
```
GET /api/personal-details/all-personal-detail/:id
```

```
GET /api/personal-details/all-personal-detail/1
```

### Success Response
```json
{
    "success": true,
    "data": {
        "personal_details": {
            "id": 1,
            "first_name": "Aryan",
            "middle_name": "Ashvinbhai",
            "last_name": "Mendapara",
            "username": "AAM",
            "date_of_birth": "2007-02-22T18:30:00.000Z",
            "gender": "male",
            "blood_group": "B+",
            "family_members_count": 4,
            "marital_status": "Unmarried",
            "dependent_children": 0,
            "email_id": "aam@gmail.com",
            "current_address": "surat",
            "permanent_address": "surat",
            "image": null,
            "mobile_number": "9558636610",
            "alternate_contact_number": "9558636610",
            "emergency_contact_name": "AAM",
            "emergency_contact_number": "9558636610",
            "emergency_relationship": "me",
            "created_at": "2026-06-19T08:57:20.276Z",
            "updated_at": "2026-06-19T08:57:20.276Z"
        },
        "employee_master": null,
        "identification_details": [
            {
                "id": 1,
                "personal_details_id": 1,
                "pan_card_number": "ABCDE1234F",
                "pan_card_upload": "https://res.cloudinary.com/deurzzaeh/image/upload/v1781762355/employee/AAM/PAN.webp",
                "aadhaar_number": "123456789012",
                "aadhaar_upload": "https://res.cloudinary.com/deurzzaeh/image/upload/v1781762356/employee/AAM/AADHAAR.pdf",
                "other_document_upload": "https://res.cloudinary.com/deurzzaeh/image/upload/v1781758526/employee/AAM/OTHER.webp",
                "created_at": "2026-06-18T04:55:26.029Z",
                "updated_at": "2026-06-18T05:59:17.588Z"
            }
        ],
        "employment_details": {
            "id": 1,
            "personal_details_id": 1,
            "employment_id": "EMP001",
            "rfid": "0001110928",
            "designation": "Software Developer",
            "department": "IT",
            "date_of_joining": "2026-06-17T18:30:00.000Z",
            "work_email": "employee@company.com",
            "employment_type": "Permanent",
            "shift_type": "General",
            "shift_time": "09:00:00",
            "work_location": "Surat",
            "reporting_manager": "John Smith",
            "probation_period": "6 Months",
            "notice_period": "2 Months",
            "bond": "No",
            "has_experience": true,
            "created_at": "2026-06-18T06:02:05.920Z",
            "updated_at": "2026-06-18T06:05:44.184Z"
        },
        "educational_qualifications": [
            {
                "id": 1,
                "personal_details_id": 1,
                "education": "B.E.",
                "university_institution": "Gujarat Technological University",
                "branch": "Computer Engineering",
                "cgpa_percentage": "8.45",
                "year_of_passing": 2025,
                "marksheet_certificate_upload": "https://res.cloudinary.com/deurzzaeh/image/upload/v1781767410/employee/AAM/MARKSHEET_CERTIFICATE.webp",
                "created_at": "2026-06-18T07:17:05.685Z",
                "updated_at": "2026-06-18T07:23:30.745Z"
            }
        ],
        "bank_details": {
            "id": 1,
            "personal_details_id": 1,
            "bank_name": "State Bank of India",
            "account_holder_name": "AAM",
            "account_number": "123456789012",
            "ifsc_code": "SBIN0001234",
            "branch_name": "Surat Main Branch",
            "bank_proof": "https://res.cloudinary.com/deurzzaeh/image/upload/v1781764794/employee/AAM/BANK_PROOF.webp",
            "created_at": "2026-06-18T06:36:08.422Z",
            "updated_at": "2026-06-18T06:39:54.520Z"
        },
        "salary_details": {
            "id": 1,
            "personal_details_id": 1,
            "current_salary": "30000.00",
            "effective_date": "2026-06-17T18:30:00.000Z",
            "next_increment_date": "2027-06-17T18:30:00.000Z",
            "expected_increment": "5000.00",
            "created_at": "2026-06-18T08:44:05.380Z",
            "updated_at": "2026-06-18T08:46:05.383Z"
        }
    }
}
```

#### ➤ Get all Employee Details
```
GET /api/personal-details/employee-complete-data
```

```
GET /api/personal-details/employee-complete-data
```

### Success Response
```json
{
  "success": true,
  "message": "All employee data fetched successfully",
  "total_employees": 7,
  "active_employees": 0,
  "pending_approval": 6,
  "inactive_employees": 1,
  "intern": 1,
  "data": [
        {
          "id": 1,
          "first_name": "TASMI",
          "middle_name": "MANISHBHAI",
          "last_name": "MANGUKIYA",
          "username": "TMM",
          "date_of_birth": "2010-06-14T18:30:00.000Z",
          "gender": "female",
          "blood_group": "A+",
          "family_members_count": 10,
          "marital_status": "unmarried",
          "anniversary_date": null,
          "dependent_children": 0,
          "email_id": "tasmi@gmail.com",
          "current_address": "405-406 Acdc Head Office, Near Mauni International School Uttran ,Surat",
          "permanent_address": "405-406 Acdc Head Office, Near Mauni International School Uttran ,Surat",
          "image": "https://res.cloudinary.com/deurzzaeh/image/upload/v1782537240/employee/TMM/TASMI.webp",
          "mobile_number": "8956230147",
          "alternate_contact_number": "7896541230",
          "emergency_contact_name": "MANISHBHAI",
          "emergency_contact_number": "7896541230",
          "emergency_relationship": "father",
          "created_at": "2026-06-24T11:01:00.445Z",
          "updated_at": "2026-06-27T05:14:01.168Z",
          "master_employee_id": 1,
          "status": "pending_approval",
          "employee_created_at": "2026-06-24T11:01:00.449Z",
          "employee_updated_at": "2026-07-04T04:00:20.341Z",
          "employment_details": {
            "id": 1,
            "personal_details_id": 1,
            "employment_id": "EMA0010626",
            "rfid": "0001062829",
            "designation": "FRONTEND",
            "department": "IT",
            "date_of_joining": "2026-06-20",
            "work_email": "acdc.it01@gmail.com",
            "employment_type": null,
            "shift_type": null,
            "shift_time": null,
            "work_location": "ACDC TECH",
            "reporting_manager": "TKA",
            "probation_period": null,
            "notice_period": null,
            "bond": null,
            "has_experience": true,
            "created_at": "2026-06-24T16:31:00.515483",
            "updated_at": "2026-07-04T09:30:20.223299",
            "sub_department": "HRMS",
            "category": "employee"
          },
          "identification_details": [
            {
              "id": 1,
              "personal_details_id": 1,
              "pan_card_number": null,
              "pan_card_upload": null,
              "aadhaar_number": null,
              "aadhaar_upload": null,
              "other_document_upload": null,
              "created_at": "2026-06-24T16:31:00.486498",
              "updated_at": "2026-06-24T16:31:00.486498"
            }
          ],
          "work_experience": [
            {
              "id": 2,
              "personal_details_id": 1,
              "company_name": "ACDC",
              "job_title": "FRONTEND DEVELOPER",
              "duration_from": "2026-05-31",
              "duration_to": "2026-06-29",
              "salary": 50000,
              "reason_for_leaving": "Personal Reasons",
              "responsibilities": "Coding Into Next Js And React Js , Frontend Designing",
              "experience_letter": "https://res.cloudinary.com/deurzzaeh/image/upload/v1782535755/employee/employee/TMM/ACDC-EXPERIENCE-LETTER.webp",
              "created_at": "2026-06-27T10:19:16.310652",
              "updated_at": "2026-07-04T09:30:20.301282"
            }
          ],
          "educational_qualifications": [
            {
              "id": 1,
              "personal_details_id": 1,
              "education": "hsc",
              "university_institution": "ASHADEEP IIT",
              "branch": "",
              "cgpa_percentage": 90,
              "year_of_passing": 2026,
              "marksheet_certificate_upload": "https://res.cloudinary.com/deurzzaeh/image/upload/v1782469275/employee/TMM/HSC-MARKSHEET_CERTIFICATE.webp",
              "created_at": "2026-06-24T16:31:00.505519",
              "updated_at": "2026-06-26T15:54:58.842263"
            },
            {
              "id": 17,
              "personal_details_id": 1,
              "education": "graduate",
              "university_institution": "DDU",
              "branch": "BCA",
              "cgpa_percentage": 92,
              "year_of_passing": 2026,
              "marksheet_certificate_upload": "https://res.cloudinary.com/deurzzaeh/image/upload/v1782469500/employee/TMM/GRADUATE-MARKSHEET_CERTIFICATE.webp",
              "created_at": "2026-06-26T15:55:00.220622",
              "updated_at": "2026-06-26T15:55:00.220622"
            }
          ],
          "bank_details": {
            "id": 1,
            "personal_details_id": 1,
            "bank_name": null,
            "account_holder_name": null,
            "account_number": null,
            "ifsc_code": null,
            "branch_name": null,
            "bank_proof": null,
            "created_at": "2026-06-24T16:31:00.494352",
            "updated_at": "2026-06-24T16:31:00.494352"
          },
          "salary_details": {
            "id": 1,
            "personal_details_id": 1,
            "current_salary": 50000,
            "effective_date": "2026-06-01",
            "next_increment_date": "2026-06-27",
            "expected_increment": 5000,
            "created_at": "2026-06-24T16:31:00.5264",
            "updated_at": "2026-07-03T18:17:41.228967"
          }
        }
    ]
}
```

#### ➤ Get Personal Details (basic details)
```
GET /api/personal-details/basic-personal-detail
```

```
GET /api/personal-details/basic-personal-detail
```

### Success Response
```json
{
    "success": true,
    "message": "Basic personal details fetched successfully",
    "data": [
      {
        "id": 24,
        "first_name": "ADP",
        "middle_name": null,
        "last_name": null,
        "username": "ADP"
      },
      {
        "id": 7,
        "first_name": "DNYANESHWAR",
        "middle_name": null,
        "last_name": null,
        "username": "DSM"
      }
    ]
}
```

#### ➤ Get Personal Details Permissions
```
GET /api/personal-details/personal-details-permissions
```

### Success Response
```json
{
    "success": true,
    "message": "Basic personal details fetched successfully",
    "data": [
        {
            "id": 37,
            "first_name": "TEST",
            "middle_name": "USER",
            "last_name": "ACDC",
            "username": "TST",
            "department": "EMBEDDED ENGINEER",
            "work_location": "ACDC TECH",
            "access": 0,
            "status": "active"
        },  
        {   
            "id": 36,
            "first_name": "KAMAL",
            "middle_name": "ZUPI",
            "last_name": "BK",
            "username": "KZB",
            "department": null,
            "work_location": "ACDC TECH",
            "access": 0,
            "status": "pending_approval"
        }
    ]
}
```

#### ➤ Update Personal Details
```
PUT /api/personal-details/update-personal-detail/:id
```

```
PUT /api/personal-details/update-personal-detail/1
```

### Success Response
```json
{
    "success": true,
    "message": "Personal details updated successfully",
    "data": {
        "id": 1,
        "first_name": "AAM",
        "middle_name": "",
        "last_name": "sir",
        "date_of_birth": "2007-02-22T18:30:00.000Z",
        "gender": "Male",
        "blood_group": "B+",
        "family_members_count": 4,
        "marital_status": "Unmarried",
        "dependent_children": 0,
        "email_id": "aam@gmail.com",
        "current_address": "Surat",
        "permanent_address": "Surat",
        "image": null,
        "mobile_number": "9876543210",
        "alternate_contact_number": "9876543211",
        "emergency_contact_name": "Father",
        "emergency_contact_number": "9876543212",
        "emergency_relationship": "Father",
        "created_at": "2026-06-16T08:53:35.824Z",
        "updated_at": "2026-06-16T09:27:50.743Z"
    }
}
```

#### ➤ Get birthday and anniversary list
```
GET /api/personal-details/birthday-anniversary-list
```

### Success Response
```json
{
  "success": true,
  "message": "Monthly birthday and wedding anniversary list fetched successfully",
  "month": 11,
  "year": 2026,
  "work_location": [],
  "total_birthdays": 2,
  "total_anniversaries": 0,
  "total": 2,
  "data": [
    {
      "personal_details_id": 11,
      "username": "JRS",
      "first_name": "JAYDEEP",
      "middle_name": "RAJUBHAI",
      "last_name": "SONDIGARA",
      "birthday_date": "2003-11-01",
      "is_birthday": true,
      "age": 23,
      "employment_id": "EMA0400426",
      "anniversary_date": null,
      "is_anniversary": false,
      "anniversary_years": null,
      "celebration_types": [
        "Birthday"
      ],
      "work_email": "acdc.engineer16@gmail.com",
      "department_id": 1,
      "department": "EMBEDDED ENGINEER",
      "designation_id": 14,
      "designation": "Jr. Embedded Hardware Engineer",
      "work_location_id": 1,
      "work_location": "ACDC TECH",
      "employee_status": "active"
    },
    {
      "personal_details_id": 14,
      "username": "JMD",
      "first_name": "JAYSHREE",
      "middle_name": "MUKESHBHAI",
      "last_name": "DER",
      "birthday_date": "2002-11-03",
      "is_birthday": true,
      "age": 24,
      "employment_id": "EMA0070126",
      "anniversary_date": null,
      "is_anniversary": false,
      "anniversary_years": null,
      "celebration_types": [
        "Birthday"
      ],
      "work_email": "acdc.engineer15@gmail.com",
      "department_id": 47,
      "department": "R&D",
      "designation_id": 14,
      "designation": "Jr. Embedded Hardware Engineer",
      "work_location_id": 1,
      "work_location": "ACDC TECH",
      "employee_status": "active"
    }
  ]
}
```

-----------------------------------------------------------------------------------------------------------

#### Identification Details

#### ➤ Add Identification Details
```
POST /api/identification-details/add-identification-detail
```

### Success Response
```json
{
    "success": true,
    "message": "Identification details added successfully",
    "data": {
        "id": 1,
        "personal_details_id": 1,
        "pan_card_number": "ABCDE1234F",
        "pan_card_upload": "https://res.cloudinary.com/deurzzaeh/image/upload/v1781758524/employee/AAM/PAN.webp",
        "aadhaar_number": "123456789012",
        "aadhaar_upload": "https://res.cloudinary.com/deurzzaeh/image/upload/v1781758525/employee/AAM/AADHAAR.webp",
        "other_document_upload": "https://res.cloudinary.com/deurzzaeh/image/upload/v1781758526/employee/AAM/OTHER.webp",
        "created_at": "2026-06-18T04:55:26.029Z",
        "updated_at": "2026-06-18T04:55:26.029Z"
    }
}
```

#### ➤ Get Identification Details
```
GET /api/identification-details/all-identification-detail
```

### Success Response
```json
{
    "success": true,
    "data": [
        {
            "id": 1,
            "personal_details_id": 1,
            "pan_card_number": "ABCDE1234F",
            "pan_card_upload": "https://res.cloudinary.com/deurzzaeh/image/upload/v1781762355/employee/AAM/PAN.webp",
            "aadhaar_number": "123456789012",
            "aadhaar_upload": "https://res.cloudinary.com/deurzzaeh/image/upload/v1781762356/employee/AAM/AADHAAR.pdf",
            "other_document_upload": "https://res.cloudinary.com/deurzzaeh/image/upload/v1781758526/employee/AAM/OTHER.webp",
            "created_at": "2026-06-18T04:55:26.029Z",
            "updated_at": "2026-06-18T05:59:17.588Z"
        }
    ]
}
```

#### ➤ Get by id Identification Details
```
GET /api/identification-details/all-identification-detail/:id
```

```
GET /api/identification-details/all-identification-detail/1
```

### Success Response
```json
{
    "success": true,
    "data": {
        "id": 1,
        "personal_details_id": 1,
        "pan_card_number": "ABCDE1234F",
        "pan_card_upload": "https://res.cloudinary.com/deurzzaeh/image/upload/v1781762355/employee/AAM/PAN.webp",
        "aadhaar_number": "123456789012",
        "aadhaar_upload": "https://res.cloudinary.com/deurzzaeh/image/upload/v1781762356/employee/AAM/AADHAAR.pdf",
        "other_document_upload": "https://res.cloudinary.com/deurzzaeh/image/upload/v1781758526/employee/AAM/OTHER.webp",
        "created_at": "2026-06-18T04:55:26.029Z",
        "updated_at": "2026-06-18T05:59:17.588Z"
    }
}
```

#### ➤ Update Identification Details
```
PUT /api/identification-details/update-identification-detail/:id
```

```
PUT /api/identification-details/update-identification-detail/1
```

### Success Response
```json
{
    "success": true,
    "message": "Identification details updated successfully",
    "data": {
        "id": 1,
        "personal_details_id": 1,
        "pan_card_number": "ABCDE1234F",
        "pan_card_upload": "https://res.cloudinary.com/deurzzaeh/image/upload/v1781762355/employee/AAM/PAN.webp",
        "aadhaar_number": "123456789012",
        "aadhaar_upload": "https://res.cloudinary.com/deurzzaeh/image/upload/v1781762356/employee/AAM/AADHAAR.pdf",
        "other_document_upload": "https://res.cloudinary.com/deurzzaeh/image/upload/v1781758526/employee/AAM/OTHER.webp",
        "created_at": "2026-06-18T04:55:26.029Z",
        "updated_at": "2026-06-18T05:59:17.588Z"
    }
}
```

-----------------------------------------------------------------------------------------------------------

#### Employment Details

#### ➤ Add Employment Details
```
POST /api/employment-details/add-employment-detail
```
Set `shift_name` and `shift_type` in the Employment Details create/update request. They resolve to `employment_details.shift_id`; payroll create/update requests no longer accept these fields.

### Success Response
```json
{
    "success": true,
    "message": "Employment details added successfully",
    "data": {
        "id": 1,
        "personal_details_id": 1,
        "employment_id": "EMP001",
        "shift_id": 2,
        "shift_name": "General",
        "rfid": "RFID123456",
        "designation": "Software Developer",
        "department": "IT",
        "date_of_joining": "2026-06-17T18:30:00.000Z",
        "work_email": "employee@company.com",
        "employment_type": "Permanent",
        "shift_type": "General",
        "shift_time": "09:00:00",
        "work_location": "Surat",
        "reporting_manager": "John Smith",
        "probation_period": "6 Months",
        "notice_period": "2 Months",
        "bond": "No",
        "has_experience": true,
        "created_at": "2026-06-18T06:02:05.920Z",
        "updated_at": "2026-06-18T06:02:05.920Z"
    }
}
```

#### ➤ Get Employment Details
```
GET /api/employment-details/all-employment-detail
```

### Success Response
```json
{
    "success": true,
    "data": [
        {
            "id": 1,
            "personal_details_id": 1,
            "employment_id": "EMP001",
            "shift_id": 2,
            "shift_name": "General",
            "rfid": "0001110928",
            "designation": "Software Developer",
            "department": "IT",
            "date_of_joining": "2026-06-17T18:30:00.000Z",
            "work_email": "employee@company.com",
            "employment_type": "Permanent",
            "shift_type": "General",
            "shift_time": "09:00:00",
            "work_location": "Surat",
            "reporting_manager": "John Smith",
            "probation_period": "6 Months",
            "notice_period": "2 Months",
            "bond": "No",
            "has_experience": true,
            "created_at": "2026-06-18T06:02:05.920Z",
            "updated_at": "2026-06-18T06:05:44.184Z"
        }
    ]
}
```

#### ➤ Get by id Employment Details
```
GET /api/employment-details/all-employment-detail/:id
```

```
GET /api/employment-details/all-employment-detail/1
```

### Success Response
```json
{
    "success": true,
    "data": {
        "id": 1,
        "personal_details_id": 1,
        "employment_id": "EMP001",
        "shift_id": 2,
        "shift_name": "General",
        "rfid": "0001110928",
        "designation": "Software Developer",
        "department": "IT",
        "date_of_joining": "2026-06-17T18:30:00.000Z",
        "work_email": "employee@company.com",
        "employment_type": "Permanent",
        "shift_type": "General",
        "shift_time": "09:00:00",
        "work_location": "Surat",
        "reporting_manager": "John Smith",
        "probation_period": "6 Months",
        "notice_period": "2 Months",
        "bond": "No",
        "has_experience": true,
        "created_at": "2026-06-18T06:02:05.920Z",
        "updated_at": "2026-06-18T06:05:44.184Z"
    }
}
```

#### ➤ Update Employment Details
```
PUT /api/employment-details/update-employment-detail/:id
```

```
PUT /api/employment-details/update-employment-detail/1
```

### Success Response
```json
{
    "success": true,
    "message": "Employment details updated successfully",
    "data": {
        "id": 1,
        "personal_details_id": 1,
        "employment_id": "EMP001",
        "shift_id": 2,
        "shift_name": "General",
        "rfid": "0001110928",
        "designation": "Software Developer",
        "department": "IT",
        "date_of_joining": "2026-06-17T18:30:00.000Z",
        "work_email": "employee@company.com",
        "employment_type": "Permanent",
        "shift_type": "General",
        "shift_time": "09:00:00",
        "work_location": "Surat",
        "reporting_manager": "John Smith",
        "probation_period": "6 Months",
        "notice_period": "2 Months",
        "bond": "No",
        "has_experience": true,
        "created_at": "2026-06-18T06:02:05.920Z",
        "updated_at": "2026-06-18T06:05:44.184Z"
    }
}
```

-----------------------------------------------------------------------------------------------------------

#### Bank Details

#### ➤ Add Bank Details
```
POST /api/bank-details/add-bank-detail
```

### Success Response
```json
{
    "success": true,
    "message": "Bank details added successfully",
    "data": {
        "id": 1,
        "personal_details_id": 1,
        "bank_name": "State Bank of India",
        "account_holder_name": "AAM",
        "account_number": "123456789012",
        "ifsc_code": "SBIN0001234",
        "branch_name": "Surat Main Branch",
        "bank_proof": "https://res.cloudinary.com/deurzzaeh/image/upload/v1781764568/employee/AAM/BANK_PROOF.pdf",
        "created_at": "2026-06-18T06:36:08.422Z",
        "updated_at": "2026-06-18T06:36:08.422Z"
    }
}
```

#### ➤ Get Bank Details
```
GET /api/bank-details/all-bank-detail
```

### Success Response
```json
{
    "success": true,
    "data": [
        {
            "id": 1,
            "personal_details_id": 1,
            "bank_name": "State Bank of India",
            "account_holder_name": "AAM",
            "account_number": "123456789012",
            "ifsc_code": "SBIN0001234",
            "branch_name": "Surat Main Branch",
            "bank_proof": "https://res.cloudinary.com/deurzzaeh/image/upload/v1781764794/employee/AAM/BANK_PROOF.webp",
            "created_at": "2026-06-18T06:36:08.422Z",
            "updated_at": "2026-06-18T06:39:54.520Z"
        }
    ]
}
```

#### ➤ Get by id Bank Details
```
GET /api/bank-details/all-bank-detail/:id
```

```
GET /api/bank-details/all-bank-detail/1
```

### Success Response
```json
{
    "success": true,
    "data": {
        "id": 1,
        "personal_details_id": 1,
        "bank_name": "State Bank of India",
        "account_holder_name": "AAM",
        "account_number": "123456789012",
        "ifsc_code": "SBIN0001234",
        "branch_name": "Surat Main Branch",
        "bank_proof": "https://res.cloudinary.com/deurzzaeh/image/upload/v1781764794/employee/AAM/BANK_PROOF.webp",
        "created_at": "2026-06-18T06:36:08.422Z",
        "updated_at": "2026-06-18T06:39:54.520Z"
    }
}
```

#### ➤ Update Bank Details
```
PUT /api/bank-details/update-employment-detail/:id
```

```
PUT /api/bank-details/update-employment-detail/1
```

### Success Response
```json
{
    "success": true,
    "message": "Bank details updated successfully",
    "data": {
        "id": 1,
        "personal_details_id": 1,
        "bank_name": "State Bank of India",
        "account_holder_name": "AAM",
        "account_number": "123456789012",
        "ifsc_code": "SBIN0001234",
        "branch_name": "Surat Main Branch",
        "bank_proof": "https://res.cloudinary.com/deurzzaeh/image/upload/v1781764794/employee/AAM/BANK_PROOF.webp",
        "created_at": "2026-06-18T06:36:08.422Z",
        "updated_at": "2026-06-18T06:39:54.520Z"
    }
}
```

-----------------------------------------------------------------------------------------------------------

#### Educational Qualifications

#### ➤ Add Educational Qualifications
```
POST /api/educational-qualifications/add-educational-qualification
```

### Success Response
```json
{
    "success": true,
    "message": "Educational qualification added successfully",
    "data": {
        "id": 1,
        "personal_details_id": 1,
        "education": "B.E.",
        "university_institution": "Gujarat Technological University",
        "branch": "Computer Engineering",
        "cgpa_percentage": "8.45",
        "year_of_passing": 2024,
        "marksheet_certificate_upload": "https://res.cloudinary.com/deurzzaeh/image/upload/v1781766144/employee/AAM/MARKSHEET_CERTIFICATE.pdf",
        "created_at": "2026-06-18T07:17:05.685Z",
        "updated_at": "2026-06-18T07:17:05.685Z"
    }
}
```

#### ➤ Get Educational Qualifications
```
GET /api/educational-qualifications/all-educational-qualification
```

### Success Response
```json
{
    "success": true,
    "data": [
        {
            "id": 1,
            "personal_details_id": 1,
            "education": "B.E.",
            "university_institution": "Gujarat Technological University",
            "branch": "Computer Engineering",
            "cgpa_percentage": "8.45",
            "year_of_passing": 2025,
            "marksheet_certificate_upload": "https://res.cloudinary.com/deurzzaeh/image/upload/v1781767410/employee/AAM/MARKSHEET_CERTIFICATE.webp",
            "created_at": "2026-06-18T07:17:05.685Z",
            "updated_at": "2026-06-18T07:23:30.745Z"
        }
    ]
}
```

#### ➤ Get by id Educational Qualifications
```
GET /api/educational-qualifications/all-educational-qualification/:id
```

```
GET /api/educational-qualifications/all-educational-qualification/1
```

### Success Response
```json
{
    "success": true,
    "data": {
        "id": 1,
        "personal_details_id": 1,
        "education": "B.E.",
        "university_institution": "Gujarat Technological University",
        "branch": "Computer Engineering",
        "cgpa_percentage": "8.45",
        "year_of_passing": 2025,
        "marksheet_certificate_upload": "https://res.cloudinary.com/deurzzaeh/image/upload/v1781767410/employee/AAM/MARKSHEET_CERTIFICATE.webp",
        "created_at": "2026-06-18T07:17:05.685Z",
        "updated_at": "2026-06-18T07:23:30.745Z"
    }
}
```

#### ➤ Update Educational Qualifications
```
PUT /api/educational-qualifications/update-educational-qualification/:id
```

```
PUT /api/educational-qualifications/update-educational-qualification/1
```

### Success Response
```json
{
    "success": true,
    "message": "Educational qualification updated successfully",
    "data": {
        "id": 1,
        "personal_details_id": 1,
        "education": "B.E.",
        "university_institution": "Gujarat Technological University",
        "branch": "Computer Engineering",
        "cgpa_percentage": "8.45",
        "year_of_passing": 2025,
        "marksheet_certificate_upload": "https://res.cloudinary.com/deurzzaeh/image/upload/v1781767410/employee/AAM/MARKSHEET_CERTIFICATE.webp",
        "created_at": "2026-06-18T07:17:05.685Z",
        "updated_at": "2026-06-18T07:23:30.745Z"
    }
}
```


#### ➤ Delete educational qualification
```
DELETE /api/educational-qualifications/delete-educational-qualification/:id
```

### Success Response
```json
{
    "success": true,
    "message": "Educational qualification deleted successfully.",
    "data": {
        "id": 61,
        "personal_details_id": 38,
        "education": "hsc",
        "university_institution": "122",
        "branch": "12",
        "cgpa_percentage": "12.00",
        "year_of_passing": 2026,
        "marksheet_certificate_upload": "https://res.cloudinary.com/deurzzaeh/image/upload/v1786181850/employee/TMM1/HSC-MARKSHEET_CERTIFICATE.webp",
        "created_at": "2026-08-08T09:37:31.024Z",
        "updated_at": "2026-08-08T09:37:31.024Z"
    }
}
```

-----------------------------------------------------------------------------------------------------------

#### Salary Details

#### ➤ Add Salary Details
```
POST /api/salary/add-salary
```

### Success Response
```json
{
    "success": true,
    "message": "Salary added successfully",
    "data": {
        "id": 1,
        "personal_details_id": 1,
        "current_salary": "35000.00",
        "effective_date": "2026-06-17T18:30:00.000Z",
        "next_increment_date": "2027-06-17T18:30:00.000Z",
        "expected_increment": "5000.00",
        "created_at": "2026-06-18T08:44:05.380Z",
        "updated_at": "2026-06-18T08:44:05.380Z"
    }
}
```

#### ➤ Get Salary Details
```
GET /api/salary/all-salary
```

### Success Response
```json
{
    "success": true,
    "data": [
        {
            "id": 1,
            "personal_details_id": 1,
            "current_salary": "30000.00",
            "effective_date": "2026-06-17T18:30:00.000Z",
            "next_increment_date": "2027-06-17T18:30:00.000Z",
            "expected_increment": "5000.00",
            "created_at": "2026-06-18T08:44:05.380Z",
            "updated_at": "2026-06-18T08:46:05.383Z"
        }
    ]
}
```

#### ➤ Get by id Salary Details
```
GET /api/salary/all-salary/:id
```

```
GET /api/salary/all-salary/1
```

### Success Response
```json
{
    "success": true,
    "data": {
        "id": 1,
        "personal_details_id": 1,
        "current_salary": "30000.00",
        "effective_date": "2026-06-17T18:30:00.000Z",
        "next_increment_date": "2027-06-17T18:30:00.000Z",
        "expected_increment": "5000.00",
        "created_at": "2026-06-18T08:44:05.380Z",
        "updated_at": "2026-06-18T08:46:05.383Z"
    }
}
```

#### ➤ Update Salary Details
```
PUT /api/salary/update-salary/:id
```

```
PUT /api/salary/update-salary/1
```

### Success Response
```json
{
    "success": true,
    "message": "Salary updated successfully",
    "data": {
        "id": 1,
        "personal_details_id": 1,
        "current_salary": "30000.00",
        "effective_date": "2026-06-17T18:30:00.000Z",
        "next_increment_date": "2027-06-17T18:30:00.000Z",
        "expected_increment": "5000.00",
        "created_at": "2026-06-18T08:44:05.380Z",
        "updated_at": "2026-06-18T08:46:05.383Z"
    }
}
```

-----------------------------------------------------------------------------------------------------------

#### Work Experience Details

#### ➤ Add Work Experience Details
```
POST /api/work-exprience/add-work-exprience
```

### Success Response
```json
{
    "success": true,
    "message": "Work experience added successfully",
    "data": {
        "id": 2,
        "personal_details_id": 1,
        "company_name": "TCS",
        "job_title": "Software Developer",
        "duration_from": "2022-05-31T18:30:00.000Z",
        "duration_to": "2023-12-31T18:30:00.000Z",
        "salary": 45000,
        "reason_for_leaving": "Career Growth",
        "responsibilities": "Backend Development",
        "experience_letter": "https://res.cloudinary.com/deurzzaeh/image/upload/v1782110148/employee/AAM/TCS-EXPERIENCE-LETTER.webp",
        "created_at": "2026-06-22T06:35:48.800Z",
        "updated_at": "2026-06-22T06:35:48.800Z"
    }
}
```

#### ➤ Get Work Experience
```
GET /api/work-exprience/all-work-exprience
```

### Success Response
```json
{
  "success": true,
  "message": "Work Experience fetch successfully",
  "data": [
    {
      "id": 2,
      "personal_details_id": 1,
      "company_name": "ACDC",
      "job_title": "FRONTEND DEVELOPER",
      "duration_from": "2026-05-30T18:30:00.000Z",
      "duration_to": "2026-06-28T18:30:00.000Z",
      "salary": 50000,
      "reason_for_leaving": "Personal Reasons",
      "responsibilities": "Coding Into Next Js And React Js , Frontend Designing",
      "experience_letter": "https://res.cloudinary.com/deurzzaeh/image/upload/v1782535755/employee/employee/TMM/ACDC-EXPERIENCE-LETTER.webp",
      "created_at": "2026-06-27T04:49:16.310Z",
      "updated_at": "2026-07-04T04:00:20.301Z"
    }
  ]
}
```

#### ➤ Get by id Work Experience 
```
GET /api/work-exprience/all-work-exprience/:id
```

```
GET /api/work-exprience/all-work-exprience/1
```

### Success Response
```json
{
  "success": true,
  "message": "Work Experience fetch successfully",
  "data": [
    {
      "id": 2,
      "personal_details_id": 1,
      "company_name": "ACDC",
      "job_title": "FRONTEND DEVELOPER",
      "duration_from": "2026-05-30T18:30:00.000Z",
      "duration_to": "2026-06-28T18:30:00.000Z",
      "salary": 50000,
      "reason_for_leaving": "Personal Reasons",
      "responsibilities": "Coding Into Next Js And React Js , Frontend Designing",
      "experience_letter": "https://res.cloudinary.com/deurzzaeh/image/upload/v1782535755/employee/employee/TMM/ACDC-EXPERIENCE-LETTER.webp",
      "created_at": "2026-06-27T04:49:16.310Z",
      "updated_at": "2026-07-04T04:00:20.301Z"
    }
  ]
}
```

#### ➤ Update Work Experience
```
PUT /api/work-exprience/update-work-exprience/:id
```

```
PUT /api/work-exprience/update-work-exprience/2
```

### Success Response
```json
{
    "success": true,
    "message": "Work experience updated successfully",
    "data": {
        "id": 2,
        "personal_details_id": 1,
        "company_name": "TC",
        "job_title": "Software Developer",
        "duration_from": "2022-05-31T18:30:00.000Z",
        "duration_to": "2023-12-31T18:30:00.000Z",
        "salary": 45000,
        "reason_for_leaving": "Career Growth",
        "responsibilities": "Backend Development",
        "experience_letter": "https://res.cloudinary.com/deurzzaeh/image/upload/v1782112568/employee/TMM/TC-EXPERIENCE-LETTER.webp",
        "created_at": "2026-06-22T06:35:48.800Z",
        "updated_at": "2026-06-22T07:16:37.877Z"
    }
}
```

#### ➤ Delete Work Experience
```
DELETE /api/work-exprience/delete-work-exprience/:id
```

```
DELETE /api/work-exprience/delete-work-exprience/2
```

### Success Response
```json
{
    "success": true,
    "message": "Work experience deleted successfully",
    "data": {
        "id": 2,
        "personal_details_id": 1,
        "company_name": "TC",
        "job_title": "Software Developer",
        "duration_from": "2022-05-31T18:30:00.000Z",
        "duration_to": "2023-12-31T18:30:00.000Z",
        "salary": 45000,
        "reason_for_leaving": "Career Growth",
        "responsibilities": "Backend Development",
        "experience_letter": "https://res.cloudinary.com/deurzzaeh/image/upload/v1782112568/employee/TMM/TC-EXPERIENCE-LETTER.webp",
        "created_at": "2026-06-22T06:35:48.800Z",
        "updated_at": "2026-06-22T07:16:37.877Z"
    }
}
```

-----------------------------------------------------------------------------------------------------------

#### Master Employee Details

#### ➤ Get Master Employee
```
GET /api/master-employee/employees
```

### Success Response
```json
{
  "success": true,
  "count": 8,
  "data": [
    {
      "id": 24,
      "status": "pending_approval",
      "username": "AWS",
      "first_name": "",
      "last_name": null,
      "mobile_number": null,
      "email_id": null,
      "created_at": "2026-07-02T13:00:11.872Z"
    },
    {
      "id": 7,
      "status": "active",
      "username": "DSM",
      "first_name": "DNYANESHWAR",
      "last_name": null,
      "mobile_number": null,
      "email_id": null,
      "created_at": "2026-06-25T12:57:45.509Z"
    }
  ]
}
```

#### ➤ Get by id Master Employee 
```
GET /api/master-employee/employees/:personal_details_id
```

```
GET /api/master-employee/employees/1
```

### Success Response
```json
{
  "success": true,
  "data": {
    "id": 1,
    "personal_details_id": 1,
    "username": "TMM",
    "status": "pending_approval",
    "created_at": "2026-06-24T11:01:00.449Z",
    "updated_at": "2026-07-04T04:00:20.341Z"
  }
}
```

#### ➤ Update Master Employee
```
PUT /api/master-employee/employees/status/:personal_details_id
```

```
PUT /api/master-employee/employees/status/2
```

### Success Response
```json
{
    "success": true,
    "message": "Status updated successfully",
    "data": {
        "id": 1,
        "personal_details_id": 2,
        "status": "active",
        "created_at": "2026-06-20T12:20:40.163Z",
        "updated_at": "2026-06-22T07:27:53.287Z",
        "username": null
    }
}
```

-----------------------------------------------------------------------------------------------------------

#### Send Mail

#### ➤ Post Master Employee
```
POST /api/employees
```

### Success Response
```json
{
    "success": true,
    "message": "Employee account created successfully",
    "data": {
        "id": 1,
        "personal_details_id": 1,
        "username": "TMM",
        "access": 1
    }
}
```

#### ➤ Get Send Mail Details
```
GET /api/employees
```

### Success Response
```json
{
  "success": true,
  "data": {
      "id": 2,
      "status": "active",
      "username": "HHK",
      "first_name": "HARSHIL",
      "last_name": "KAKADIYA",
      "mobile_number": "9879685653",
      "email_id": "harshilkakadiya9879@gmail.com",
      "created_at": "2026-07-09T05:57:53.677Z"
    },
    {
      "id": 1,
      "status": "active",
      "username": "ABD",
      "first_name": "AMI",
      "last_name": "DESAI",
      "mobile_number": "7984256803",
      "email_id": "amidesai256@gmail.com",
      "created_at": "2026-07-09T05:57:53.677Z"
    }
}
```

#### ➤ Update Master Employee
```
PUT /api/master-employee/employees/status/:personal_details_id
```

```
PUT /api/master-employee/employees/status/2
```

### Success Response
```json
{
    "success": true,
    "message": "Status updated successfully",
    "data": {
        "id": 1,
        "personal_details_id": 2,
        "status": "active",
        "created_at": "2026-06-20T12:20:40.163Z",
        "updated_at": "2026-06-22T07:27:53.287Z",
        "username": null
    }
}
```

-----------------------------------------------------------------------------------------------------------

#### Attendance History Log

#### ➤ Get History Log
```
GET /api/attendance-logs
```

### Success Response
```json
{
  "success": true,
  "message": "Attendance logs fetched successfully",
  "count": 135,
  "data": [
    {
      "id": 135,
      "type": "delete",
      "employee_id": "EMA0010626",
      "username": "TMM",
      "user_at": "TMM",
      "old_value": "{\"rfid\":\"0001062829\",\"username\":\"TMM\",\"entry_mac_id\":\"14335C698624\",\"exit_mac_id\":\"14335C698624\",\"entry_at\":\"16:13:25\",\"exit_at\":\"16:16:48\",\"duration\":{\"minutes\":3,\"seconds\":23},\"status\":\"completed\"}",
      "new_value": null,
      "created_at": "03-07-2026 17:07:12",
      "updated_at": "03-07-2026 17:07:12"
    },
    {
      "id": 134,
      "type": "delete",
      "employee_id": "EMA0010626",
      "username": "TMM",
      "user_at": "TMM",
      "old_value": "{\"rfid\":\"0001062829\",\"username\":\"TMM\",\"entry_mac_id\":\"14335C698624\",\"exit_mac_id\":\"14335C698624\",\"entry_at\":\"16:27:43\",\"exit_at\":\"16:27:54\",\"duration\":{\"seconds\":11},\"status\":\"completed\"}",
      "new_value": null,
      "created_at": "03-07-2026 17:07:10",
      "updated_at": "03-07-2026 17:07:10"
    }
  ]
}
```

#### ➤ Get by id History Log
```
GET /api/attendance-logs/1
```

### Success Response
```json
{
  "success": true,
  "message": "Attendance log fetched successfully",
  "data": {
    "id": 1,
    "type": "add",
    "employee_id": null,
    "username": "AAM",
    "user_at": "ADMIN1",
    "old_value": null,
    "new_value": "{\"id\":1,\"rfid\":\"0001110928\",\"username\":\"AAM\",\"mac_id\":\"MANUAL\",\"entry_at\":\"09:00:00\",\"exit_at\":\"12:52:38\",\"duration\":{\"hours\":3,\"minutes\":52,\"seconds\":38},\"entry_message_id\":null,\"exit_message_id\":null,\"status\":\"completed\",\"created_at\":\"2026-06-27T07:22:44.265Z\",\"updated_at\":\"2026-06-27T07:22:44.265Z\"}",
    "created_at": "27-06-2026 12:52:44",
    "updated_at": "27-06-2026 12:52:44"
  }
}
```

-----------------------------------------------------------------------------------------------------------

#### Setting edit Log

#### ➤ POST edit Log
```
POST /api/setting-logs/add
```

#### ➤ Get Setting edit Log
```
GET /api/setting-logs
```

### Success Response
```json
{
    "success": true,
    "message": "Setting edit logs fetched successfully",
    "data": [
        {
            "id": 1,
            "type": "update",
            "username": "AAM",
            "user_at": "ADMIN1"
        }
    ]
}
```

-----------------------------------------------------------------------------------------------------------

#### Payroll

#### ➤ Get History Log
```
GET /api/payroll/employees
```

### Success Response
```json
{
  "success": true,
  "message": "Employees fetched successfully.",
  "data": [
    {
      "employmentId": "EMA0050924",
      "username": "ABD",
      "firstName": "AMI",
      "middleName": "BHARATBHAI",
      "lastName": "DESAI",
      "work_location": "ACDC TECH",
      "shiftName": "ACDC TECH",
      "shiftType": "Morning",
      "startTime": "09:00:00",
      "endTime": "18:30:00",
      "status": "active",
      "month": "August",
      "year": 2026,
      "attendance": 0,
      "totalHours": "::00",
      "totalMinutes": 0,
      "totalOvertimeMinutes": 0,
      "companyTotalDays": 2,
      "companyTotalMinutes": 1140,
      "dailyRecords": []
    },
    {
      "employmentId": "EMA0150626",
      "username": "HHK",
      "firstName": "HARSHIL",
      "middleName": "HITESHBHAI",
      "lastName": "KAKADIYA",
      "work_location": "ACDC TECH",
      "shiftName": "ACDC TECH",
      "shiftType": "Morning",
      "startTime": "09:00:00",
      "endTime": "18:30:00",
      "status": "active",
      "month": "August",
      "year": 2026,
      "attendance": 0,
      "totalHours": "::00",
      "totalMinutes": 0,
      "totalOvertimeMinutes": 0,
      "companyTotalDays": 2,
      "companyTotalMinutes": 1140,
      "dailyRecords": []
    }
  ]
}
```

#### ➤ Get salary stats
```
GET /api/payroll/salary-stats?month=10&year=2026
```

Optional: `work_location`

### Success Response
```json
{
    "success": true,
    "message": "Payroll salary statistics fetched successfully",
    "data": {
        "month": 10,
        "year": 2026,
        "employee_count": 9,
        "total_basic_salary": 107000,
        "total_net_salary": 271486.5
    }
}
```

#### ➤ Update payroll salary status
```
PATCH /api/payroll/status/:id
```

```
PATCH /api/payroll/status/12
```

```json
{
    "salary_status": "Approved"
}
```

Header: `x-username`

### Success Response
```json
{
    "success": true,
    "message": "Payroll salary_status updated to Approved",
    "data": {
        "id": 12,
        "username": "GPV",
        "payroll_month": 10,
        "payroll_year": 2026,
        "salary_status": "Approved",
        "approved_by": "HR",
        "approved_at": "2026-10-16T11:30:00.000Z"
    }
}
```

#### ➤ Update payroll salary status (alias)
```
PATCH /api/payroll/payroll-status/:id
```

```
PATCH /api/payroll/payroll-status/12
```

Same body and response as `/api/payroll/status/:id`.

-----------------------------------------------------------------------------------------------------------

#### Download Attendance

#### ➤ Get attendance
```
GET /api/download/attendance
```

-----------------------------------------------------------------------------------------------------------

#### Download Attendance and employee worksheet

#### ➤ Get attendance and employee worksheet
```
GET /api/compare-attendance/attendance
```

-----------------------------------------------------------------------------------------------------------

#### Offer Letter Format

#### ➤ Get offer letter format
```
GET /api/offer-letter-format
```

### Success Response
```json
{
    "success": true,
    "message": "Offer letter template fetched successfully",
    "data": {
        "id": 1,
        "work_location": "ACDC TECH",
        "content_html": "<p>Offer letter body</p>"
    }
}
```

#### ➤ Update offer letter template
```
PUT /api/offer-letter-format
```

```json
{
    "work_location": "ACDC TECH",
    "content_html": "<p>Updated offer letter body</p>"
}
```

### Success Response
```json
{
    "success": true,
    "message": "Offer letter template updated successfully",
    "data": {
        "id": 1,
        "work_location": "ACDC TECH",
        "content_html": "<p>Updated offer letter body</p>"
    }
}
```

#### ➤ Get offer letter history
```
GET /api/offer-letter-format/history
```

### Success Response
```json
{
    "success": true,
    "data": [
        {
            "id": 1,
            "work_location": "ACDC TECH",
            "updated_at": "2026-10-16T11:30:00.000Z"
        }
    ]
}
```

-----------------------------------------------------------------------------------------------------------

#### User Page Permissions

#### ➤ Get permissions
```
GET /api/users/:username/permissions
```

```
GET /api/users/AAM/permissions
```

### Success Response
```json
{
    "success": true,
    "data": {
        "username": "AAM",
        "permissions": ["dashboard", "attendance", "payroll"]
    }
}
```

#### ➤ Create permissions
```
POST /api/users/:username/permissions
```

```
POST /api/users/AAM/permissions
```

```json
{
    "permissions": ["dashboard", "attendance"]
}
```

### Success Response
```json
{
    "success": true,
    "message": "Permissions saved successfully",
    "data": {
        "username": "AAM",
        "permissions": ["dashboard", "attendance"]
    }
}
```

#### ➤ Update permissions
```
PUT /api/users/:username/permissions
```

```
PUT /api/users/AAM/permissions
```

```json
{
    "permissions": ["dashboard", "attendance", "payroll"]
}
```

### Success Response
```json
{
    "success": true,
    "message": "Permissions saved successfully",
    "data": {
        "username": "AAM",
        "permissions": ["dashboard", "attendance", "payroll"]
    }
}
```

-----------------------------------------------------------------------------------------------------------

#### Status

#### ➤ Add Status
```
POST /api/status/add-status
```

```json
{
    "status_name": "Shortlisted"
}
```

### Success Response
```json
{
    "success": true,
    "message": "Status created successfully",
    "data": {
        "id": 1,
        "status_name": "Shortlisted",
        "is_active": true
    }
}
```

#### ➤ Get Status
```
GET /api/status/all-status
```

### Success Response
```json
{
    "success": true,
    "message": "Status fetched successfully",
    "data": [
        {
            "id": 1,
            "status_name": "Shortlisted",
            "is_active": true
        }
    ]
}
```

#### ➤ Get Status By Id
```
GET /api/status/all-status/:id
```

```
GET /api/status/all-status/1
```

### Success Response
```json
{
    "success": true,
    "message": "Status fetched successfully",
    "data": {
        "id": 1,
        "status_name": "Shortlisted",
        "is_active": true
    }
}
```

#### ➤ Update Status
```
PUT /api/status/update-status/:id
```

```
PUT /api/status/update-status/1
```

```json
{
    "status_name": "Selected"
}
```

### Success Response
```json
{
    "success": true,
    "message": "Status updated successfully",
    "data": {
        "id": 1,
        "status_name": "Selected",
        "is_active": true
    }
}
```

#### ➤ Update Toggle
```
PATCH /api/status/toggle/:id
```

```
PATCH /api/status/toggle/1
```

Header: `x-username`

### Success Response
```json
{
    "success": true,
    "message": "Status toggled successfully",
    "data": {
        "id": 1,
        "status_name": "Selected",
        "is_active": false
    }
}
```

-----------------------------------------------------------------------------------------------------------

#### Global Calendar

#### ➤ Monthly calendar
```
GET /api/calendar/global-monthly?year=2026&month=10
```

Query: `year`, `month` (required), `username`, `types`, `work_location`

### Success Response
```json
{
    "success": true,
    "message": "Global calendar fetched successfully",
    "data": []
}
```

#### ➤ Yearly calendar
```
GET /api/calendar/global-yearly?year=2026
```

Query: `year`, `yearly_filter=joining_date|financial_year`, `financial_year`, `username`, `types`, `work_location`

### Success Response
```json
{
    "success": true,
    "message": "Global calendar fetched successfully",
    "data": []
}
```

-----------------------------------------------------------------------------------------------------------

#### Candidate

#### ➤ Add Candidate
```
POST /api/candidate/add-candidate
```

`multipart/form-data` (image, resume, identity and education files)

### Success Response
```json
{
    "success": true,
    "message": "Candidate added successfully",
    "data": {
        "id": 1,
        "first_name": "Ami",
        "last_name": "Desai",
        "status": "Applied"
    }
}
```

#### ➤ Transfer candidate to employee
```
POST /api/candidate/transfer-to-employee/:id
```

```
POST /api/candidate/transfer-to-employee/1
```

### Success Response
```json
{
    "success": true,
    "message": "Candidate transferred to employee successfully",
    "data": {
        "id": 1,
        "transferred": true
    }
}
```

#### ➤ Get Candidates
```
GET /api/candidate/all-candidate
```

### Success Response
```json
{
    "success": true,
    "message": "Candidates fetched successfully",
    "data": [
        {
            "id": 1,
            "first_name": "Ami",
            "last_name": "Desai",
            "status": "Applied"
        }
    ]
}
```

#### ➤ Get Candidate By Id
```
GET /api/candidate/all-candidate/:id
```

```
GET /api/candidate/all-candidate/1
```

### Success Response
```json
{
    "success": true,
    "message": "Candidate fetched successfully",
    "data": {
        "id": 1,
        "first_name": "Ami",
        "last_name": "Desai",
        "status": "Applied"
    }
}
```

#### ➤ Get candidate resume
```
GET /api/candidate/resume/:fileName
```

```
GET /api/candidate/resume/resume.pdf
```

Success: file stream of the resume.

#### ➤ Get candidate status stats
```
GET /api/candidate/candidate-status-stats
```

### Success Response
```json
{
    "success": true,
    "data": {
        "Applied": 4,
        "Shortlisted": 2,
        "Selected": 1
    }
}
```

#### ➤ Update Candidate
```
PUT /api/candidate/update-candidate/:id
```

```
PUT /api/candidate/update-candidate/1
```

`multipart/form-data`

### Success Response
```json
{
    "success": true,
    "message": "Candidate updated successfully",
    "data": {
        "id": 1,
        "first_name": "Ami",
        "last_name": "Desai",
        "status": "Shortlisted"
    }
}
```

-----------------------------------------------------------------------------------------------------------

#### Candidate Source

#### ➤ Add Candidate Source
```
POST /api/candidate-source/add-candidate-source
```

```json
{
    "source_name": "LinkedIn"
}
```

Header: `x-username`

### Success Response
```json
{
    "success": true,
    "message": "Candidate source created successfully",
    "data": {
        "id": 1,
        "source_name": "LinkedIn"
    }
}
```

#### ➤ Get Candidate Sources
```
GET /api/candidate-source/all-candidate-sources
```

### Success Response
```json
{
    "success": true,
    "message": "Candidate sources fetched successfully",
    "data": [
        {
            "id": 1,
            "source_name": "LinkedIn"
        }
    ]
}
```

#### ➤ Get Candidate Source By Id
```
GET /api/candidate-source/all-candidate-sources/:id
```

```
GET /api/candidate-source/all-candidate-sources/1
```

### Success Response
```json
{
    "success": true,
    "message": "Candidate source fetched successfully",
    "data": {
        "id": 1,
        "source_name": "LinkedIn"
    }
}
```

#### ➤ Update Candidate Source
```
PUT /api/candidate-source/update-candidate-source/:id
```

```
PUT /api/candidate-source/update-candidate-source/1
```

```json
{
    "source_name": "Naukri"
}
```

Header: `x-username`

### Success Response
```json
{
    "success": true,
    "message": "Candidate source updated successfully",
    "data": {
        "id": 1,
        "source_name": "Naukri"
    }
}
```

-----------------------------------------------------------------------------------------------------------

#### Job Position

#### ➤ Add Job Position
```
POST /api/job-position/add-job-position
```

```json
{
    "job_title": "Backend Developer",
    "number_of_positions": 2,
    "status": true
}
```

### Success Response
```json
{
    "success": true,
    "message": "Job position created successfully",
    "data": {
        "id": 1,
        "job_title": "Backend Developer",
        "number_of_positions": 2,
        "status": true
    }
}
```

#### ➤ Get Job Positions
```
GET /api/job-position/all-job-position
```

### Success Response
```json
{
    "success": true,
    "message": "Job positions fetched successfully",
    "data": [
        {
            "id": 1,
            "job_title": "Backend Developer",
            "number_of_positions": 2,
            "status": true
        }
    ]
}
```

#### ➤ Get Job Position By Id
```
GET /api/job-position/all-job-position/:id
```

```
GET /api/job-position/all-job-position/1
```

### Success Response
```json
{
    "success": true,
    "message": "Job position fetched successfully",
    "data": {
        "id": 1,
        "job_title": "Backend Developer",
        "number_of_positions": 2,
        "status": true
    }
}
```

#### ➤ Update Job Position
```
PUT /api/job-position/update-job-position/:id
```

```
PUT /api/job-position/update-job-position/1
```

```json
{
    "job_title": "Senior Backend Developer",
    "number_of_positions": 1,
    "status": true
}
```

### Success Response
```json
{
    "success": true,
    "message": "Job position updated successfully",
    "data": {
        "id": 1,
        "job_title": "Senior Backend Developer",
        "number_of_positions": 1,
        "status": true
    }
}
```

#### ➤ Update Toggle
```
PATCH /api/job-position/toggle/:id
```

```
PATCH /api/job-position/toggle/1
```

### Success Response
```json
{
    "success": true,
    "message": "Job position status changed to inactive successfully",
    "data": {
        "id": 1,
        "job_title": "Senior Backend Developer",
        "number_of_positions": 1,
        "status": false
    }
}
```

-----------------------------------------------------------------------------------------------------------

#### Meeting Schedule

#### ➤ Add Meeting Schedule
```
POST /api/meeting-Schedule/add-meeting-schedule
```

```json
{
    "schedule_date": "2026-10-20",
    "start_time": "10:00:00",
    "end_time": "11:00:00",
    "scheduled_person_name": "AAM",
    "conduct_person_name": "HR"
}
```

### Success Response
```json
{
    "success": true,
    "message": "Meeting scheduled successfully",
    "data": {
        "id": 1,
        "schedule_date": "2026-10-20",
        "start_time": "10:00:00",
        "end_time": "11:00:00",
        "scheduled_person_name": "AAM",
        "conduct_person_name": "HR"
    }
}
```

#### ➤ Get Meeting Schedules
```
GET /api/meeting-Schedule/all-meeting-schedule
```

### Success Response
```json
{
    "success": true,
    "data": [
        {
            "id": 1,
            "schedule_date": "2026-10-20",
            "start_time": "10:00:00",
            "end_time": "11:00:00",
            "scheduled_person_name": "AAM",
            "conduct_person_name": "HR"
        }
    ]
}
```

#### ➤ Get Meeting Schedule By Id
```
GET /api/meeting-Schedule/all-meeting-schedule/:id
```

```
GET /api/meeting-Schedule/all-meeting-schedule/1
```

### Success Response
```json
{
    "success": true,
    "data": {
        "id": 1,
        "schedule_date": "2026-10-20",
        "start_time": "10:00:00",
        "end_time": "11:00:00",
        "scheduled_person_name": "AAM",
        "conduct_person_name": "HR"
    }
}
```

#### ➤ Update Meeting Schedule
```
PUT /api/meeting-Schedule/update-meeting-schedule/:id
```

```
PUT /api/meeting-Schedule/update-meeting-schedule/1
```

### Success Response
```json
{
    "success": true,
    "message": "Meeting schedule updated successfully",
    "data": {
        "id": 1,
        "schedule_date": "2026-10-20",
        "start_time": "11:00:00",
        "end_time": "12:00:00"
    }
}
```

#### ➤ Delete Meeting Schedule
```
DELETE /api/meeting-Schedule/delete-meeting-schedule/:id
```

```
DELETE /api/meeting-Schedule/delete-meeting-schedule/1
```

### Success Response
```json
{
    "success": true,
    "message": "Meeting schedule deleted successfully",
    "data": {
        "id": 1
    }
}
```

-----------------------------------------------------------------------------------------------------------

#### Employee Meeting

#### ➤ Add Employee Meeting
```
POST /api/employee-meeting
```

```json
{
    "meeting_date": "2026-10-20",
    "start_time": "10:00:00",
    "end_time": "11:00:00",
    "meeting_members": ["AAM", "ABD"]
}
```

### Success Response
```json
{
    "success": true,
    "message": "Employee meeting created successfully",
    "data": {
        "id": 1,
        "meeting_date": "2026-10-20",
        "start_time": "10:00:00",
        "end_time": "11:00:00"
    }
}
```

#### ➤ Get Employee Meetings
```
GET /api/employee-meeting
```

### Success Response
```json
{
    "success": true,
    "message": "Employee meetings fetched successfully",
    "data": [
        {
            "id": 1,
            "meeting_date": "2026-10-20",
            "start_time": "10:00:00",
            "end_time": "11:00:00"
        }
    ]
}
```

#### ➤ Get Employee Meeting By Id
```
GET /api/employee-meeting/:id
```

```
GET /api/employee-meeting/1
```

### Success Response
```json
{
    "success": true,
    "message": "Employee meeting fetched successfully",
    "data": {
        "id": 1,
        "meeting_date": "2026-10-20",
        "start_time": "10:00:00",
        "end_time": "11:00:00"
    }
}
```

#### ➤ Update Employee Meeting
```
PUT /api/employee-meeting/:id
```

```
PUT /api/employee-meeting/1
```

### Success Response
```json
{
    "success": true,
    "message": "Employee meeting updated successfully",
    "data": {
        "id": 1,
        "meeting_date": "2026-10-21",
        "start_time": "10:00:00",
        "end_time": "11:00:00"
    }
}
```

#### ➤ Delete Employee Meeting
```
DELETE /api/employee-meeting/:id
```

```
DELETE /api/employee-meeting/1
```

### Success Response
```json
{
    "success": true,
    "message": "Employee meeting cancelled successfully",
    "data": {
        "id": 1
    }
}
```

-----------------------------------------------------------------------------------------------------------

#### Payroll Report

#### ➤ Employee salary report
```
GET /api/payroll-report/employee-salary-report?type=monthly&month=10&year=2026
```

Yearly:
```
GET /api/payroll-report/employee-salary-report?type=yearly&yearly_filter=joining_date&year=2026
```

```
GET /api/payroll-report/employee-salary-report?type=yearly&yearly_filter=financial_year&year=2026
```

Optional: `work_location`, `name`, `username`

### Success Response
```json
{
    "success": true,
    "data": {
        "type": "monthly",
        "month": 10,
        "year": 2026,
        "employee_count": 9,
        "total_basic_salary": 107000,
        "total_net_salary": 271486.5,
        "employees": []
    }
}
```

#### ➤ Employee increment report
```
GET /api/payroll-report/employee-increment-report
```

Optional: `work_location`, `name`, `username`

### Success Response
```json
{
    "success": true,
    "data": {
        "employee_count": 9,
        "total_first_salary": 88000,
        "total_current_salary": 128000,
        "total_increment": 40000,
        "increment_percentage": 45.45,
        "years": ["2023-24", "2024-25", "2025-26", "2026-27"],
        "chart": [],
        "employees": []
    }
}
```

#### ➤ Company salary report
```
GET /api/payroll-report/company-salary-report?type=monthly&month=10&year=2026
```

Yearly:
```
GET /api/payroll-report/company-salary-report?type=yearly&yearly_filter=joining_date&year=2026
```

```
GET /api/payroll-report/company-salary-report?type=yearly&yearly_filter=financial_year&year=2026
```

Optional: `work_location`

Counts **Paid** `net_salary` only.

### Success Response
```json
{
    "success": true,
    "message": "Monthly company salary report fetched successfully",
    "data": {
        "type": "monthly",
        "month": 10,
        "year": 2026,
        "total_paid_net_salary": 150000
    }
}
```

-----------------------------------------------------------------------------------------------------------

#### Employee Payroll Config

#### ➤ Create employee payroll
```
POST /api/employee-payroll
```

Payload:
```json
{
    "username": "TMM",
    "working_start_time": "09:00:00",
    "working_end_time": "18:30:00",
    "payroll_start_date": "2026-11-16",
    "payroll_end_date": "2026-11-30",
    "applicable_date": "2026-11-16",
    "payroll_month": 11,
    "payroll_year": 2026,
    "day_type": "Full Day",
    "current_salary": 55000,
    "next_increment_date": "2026-12-01"
}
```
Set `shift_name` and `shift_type` in Employment Details; payroll reads the shift from that record.

### Success Response
```json
{
    "success": true,
    "message": "Payroll configuration, salary details, and payroll saved successfully",
    "data": {
        "id": 1,
        "username": "GPV"
    }
}
```

#### ➤ Generate payroll
```
POST /api/employee-payroll/generate
```

Header: `x-username`

```json
{
    "month": 10,
    "year": 2026
}
```

Sets `generated=true`, fills `generated_by` and `generated_at`. After this, list API shows `currentMonthAccruedSalary`.

### Success Response
```json
{
    "success": true,
    "message": "Payroll generated successfully",
    "data": []
}
```

#### ➤ Get employee payroll list
```
GET /api/employee-payroll?month=10&year=2026&page=1&limit=20
```

Optional: `work_location`, `category`, `name`, `serial_number`, `payroll_status`, `basic_salary`, `shift`, `working_start_time`, `working_end_time`.
`basic_salary` matches the payroll basic salary amount for the selected `month` and `year`.
`shift` matches either the shift name or shift type from Employment Details. Working-time filters match the payroll configuration selected for that month.
`serial_number`, `salary_status`, `payroll_status`, `basic_salary`, `shift`, `working_start_time`, and `working_end_time` support partial, case-insensitive matching as you type.

### Success Response
```json
{
    "success": true,
    "message": "Employee data fetched successfully",
    "data": []
}
```

#### ➤ Download employee payroll
```
GET /api/employee-payroll/download
```

Success: Excel file download.

#### ➤ Get configs expiring this month
```
GET /api/employee-payroll/expiring-this-month
```

### Success Response
```json
{
    "success": true,
    "message": "Current month expiring payroll configurations fetched successfully",
    "data": []
}
```

#### ➤ Get config by username
```
GET /api/employee-payroll/:username
```

```
GET /api/employee-payroll/GPV
```

### Success Response
```json
{
    "success": true,
    "data": {
        "id": 1,
        "username": "GPV"
    }
}
```

#### ➤ Update employee payroll config
```
PUT /api/employee-payroll/:id
```

```
PUT /api/employee-payroll/1
```

### Success Response
```json
{
    "success": true,
    "message": "Payroll configuration updated successfully",
    "data": {
        "id": 1,
        "username": "GPV"
    }
}
```

#### ➤ Delete employee payroll config
```
DELETE /api/employee-payroll/:id
```

```
DELETE /api/employee-payroll/1
```

### Success Response
```json
{
    "success": true,
    "message": "Payroll configuration deleted successfully",
    "data": {
        "id": 1
    }
}
```

-----------------------------------------------------------------------------------------------------------

#### Import Employee

#### ➤ Import Excel
```
POST /api/import/import-excel
```

`multipart/form-data` field: `file`

### Success Response
```json
{
    "success": true,
    "message": "Employee data imported successfully",
    "data": {
        "imported": 10
    }
}
```

-----------------------------------------------------------------------------------------------------------

#### Calendar Logs

#### ➤ Get calendar edit logs
```
GET /api/calendar-logs
```

### Success Response
```json
{
    "success": true,
    "data": []
}
```

-----------------------------------------------------------------------------------------------------------

#### Employee Logs

#### ➤ Get employee edit logs
```
GET /api/employee-logs
```

### Success Response
```json
{
    "success": true,
    "data": []
}
```

-----------------------------------------------------------------------------------------------------------

#### Device Version Logs

#### ➤ Get device version logs
```
GET /api/device-version-logs
```

### Success Response
```json
{
    "success": true,
    "data": []
}
```

-----------------------------------------------------------------------------------------------------------

#### Maintenance

#### ➤ Get maintenance
```
GET /api/maintenance
```

### Success Response
```json
{
    "success": true,
    "message": "Maintenance data fetched successfully",
    "data": {
        "id": 1,
        "is_maintenance": false
    }
}
```

#### ➤ Save maintenance
```
POST /api/maintenance
```

```json
{
    "is_maintenance": true
}
```

### Success Response
```json
{
    "success": true,
    "message": "Maintenance saved successfully",
    "data": {
        "id": 1,
        "is_maintenance": true
    }
}
```

-----------------------------------------------------------------------------------------------------------

#### Offer Letter Format

#### ➤ Download offer letter
```
GET /api/offer-letter-format/download
```

#### ➤ Download offer letter from content
```
POST /api/offer-letter-format/download-letter
```

#### ➤ Get employee field names
```
GET /api/offer-letter-format/employee-field-names
```

-----------------------------------------------------------------------------------------------------------

#### User Sessions

#### ➤ Logout user session
```
POST /api/users/logout
```

### Success Response
```json
{
    "success": true,
    "message": "Logged out successfully",
    "data": {
        "session_id": "046afd28-e5c5-46fa-b46e-6e500073bf50",
        "logout_at": "2026-10-19T05:03:53.075Z",
        "is_online": false
    }
}
```

#### ➤ Update user session heartbeat
```
POST /api/users/heartbeat
```

### Success Response
```json
{
    "success": true,
    "message": "Heartbeat updated successfully",
    "data": {
        "session_id": "71e92037-b404-47f2-9ec2-4ca012b998c7",
        "last_seen_at": "2026-10-26T05:34:26.843Z",
        "last_activity_at": "2026-10-26T05:26:17.265Z",
        "activity": false,
        "status": "away",
        "is_online": false,
        "is_away": true
    }
}
```

#### ➤ Get online status
```
GET /api/users/online-status
```

#### ➤ Get online users
```
GET /api/users/online
```

-----------------------------------------------------------------------------------------------------------

#### Recruitment and Meetings

#### ➤ Get candidate board preference
```
GET /api/candidate/board-preference
```

### Success Response
```json
{
  "success": true,
  "message": "Board preference fetched successfully.",
  "data": {
    "status_order": [1, 3, 4, 5, 6, 7, 8, 9, 10, 12],
    "card_order": {
      "1": [43],
      "3": [],
      "4": [],
      "5": [],
      "6": []
    }
  }
}
```

#### ➤ Save candidate board preference
```
PUT /api/candidate/board-preference
```

### Success Response
```json
{
    "success": true,
    "message": "Board preference saved.",
    "data": {
        "status_order": [
            4,
            1,
            3,
            2
        ],
        "card_order": {
            "1": [
                77,
                90
            ],
            "4": [
                101,
                88,
                54
            ]
        }
    }
}
```

#### ➤ Get latest meeting
```
GET /api/meeting-Schedule/latest-meeting
```

### Success Response
```json
{
  "success": true,
  "message": "Latest meeting per candidate fetched successfully",
  "count": 6,
  "latest_meeting": [
    {
      "candidate_id": 2,
      "is_busy": false,
      "is_pending": false,
      "schedule_date": "2026-10-27",
      "start_time": "10:00:00",
      "end_time": "11:00:00"
    },
    {
      "candidate_id": 29,
      "is_busy": false,
      "is_pending": false,
      "schedule_date": "2026-10-26",
      "start_time": "07:00:00",
      "end_time": "08:00:00"
    }
  ]
}
```

-----------------------------------------------------------------------------------------------------------

#### Payroll

#### ➤ Get payroll status details
```
GET /api/payroll/payroll-status-details?month=10&year=2026
```

### Success Response
```json
{
  "success": true,
  "message": "Approved and pending payroll details fetched successfully",
  "data": {
    "month": 10,
    "year": 2026,
    "summary": {
      "total_records": 1,
      "non_approved_count": 1,
      "non_paid_count": 0,
      "non_generated_count": 0
    },
    "non_generated": [],
    "non_approved": [
      {
        "payroll_record_id": 15,
        "payroll_id": "2",
        "username": "TMM",
        "first_name": "TASMI",
        "middle_name": "MANISHBHAI",
        "last_name": "MANGUKIYA",
        "employee_name": "TASMI MANISHBHAI MANGUKIYA",
        "payroll_month": 10,
        "payroll_year": 2026,
        "basic_salary": 50000,
        "overtime_minutes": -7611,
        "overtime_hours": "-126.85",
        "overtime_amount": "-26705.26",
        "net_salary": "25294.74",
        "salary_status": "Pending",
        "generated": true,
        "generated_at": "2026-10-29T04:58:48.126Z",
        "approved_by": null,
        "approved_at": null,
        "paid_by": null,
        "paid_at": null,
        "created_at": "2026-10-29T04:58:48.117Z",
        "updated_at": "2026-10-29T08:56:06.543Z"
      }
    ],
    "non_paid": []
  }
}
```

#### ➤ Get monthly employee report
```
GET /api/payroll/monthly-employee-report?month=10&year=2026
```

#### ➤ Get financial year salary report
```
GET /api/payroll-report/financial-year-salary-report
```

### Success Response
```json
{
  "success": true,
  "message": "Financial year salary report fetched successfully",
  "data": [
    {
      "financial_year": "2026-27",
      "employee_count": 5,
      "total_basic_salary": 0,
      "total_paid": 33449.34,
      "total_pending": 306859.72,
      "total_net_salary": 340309.06,
      "paid_percentage": 9.83,
      "pending_percentage": 90.17
    }
  ]
}
```

#### ➤ Get employee payroll configuration
```
GET /api/employee-payroll/employee-payroll-config
```
Optional: `username`, `status`, `serial_number`. These filters partially match their configuration fields (case-insensitive); `status` filters configuration `status`, not payroll `salary_status`. Every configuration includes top-level `total_records` and `latest_salary_status` (from the last payroll record in descending period order). When `username` is omitted, nested payroll records are omitted. When supplied, only matching configurations are returned with their payroll records attached. Payroll records include `total_minutes` (worked attendance minutes), `total_hours` (`HHH:MM`), and `total_amount` (basic salary prorated by worked minutes over standard working minutes).

### Success Response
```json
    {
      "id": 5,
      "serial_number": "CNT-2627-005",
      "username": "SJA",
      "shift_id": 1,
      "shift_name": "ACDC TECH",
      "shift_type": "Morning",
      "working_start_time": "09:00:00",
      "working_end_time": "18:30:00",
      "payroll_start_date": "2026-12-31T18:30:00.000Z",
      "payroll_end_date": "2027-02-27T18:30:00.000Z",
      "applicable_date": "2026-10-26T18:30:00.000Z",
      "day_type": "Full Day",
      "status": "pending",
      "created_by": "TMM",
      "updated_by": "TMM",
      "created_at": "2026-10-27T04:27:03.391Z",
      "updated_at": "2026-10-27T04:27:03.391Z",
      "current_salary": 60000,
      "next_increment_date": "2027-02-28T18:30:00.000Z",
      "payroll": {
        "total_records": 0,
        "records": []
      }
    },
    {
      "id": 6,
      "serial_number": "CNT-2627-006",
      "username": "AAM",
      "shift_id": 2,
      "shift_name": "General",
      "shift_type": "General",
      "working_start_time": "09:00:00",
      "working_end_time": "18:30:00",
      "payroll_start_date": "2026-12-31T18:30:00.000Z",
      "payroll_end_date": "2027-02-27T18:30:00.000Z",
      "applicable_date": "2026-10-26T18:30:00.000Z",
      "day_type": "Full Day",
      "status": "pending",
      "created_by": "TMM",
      "updated_by": "TMM",
      "created_at": "2026-10-27T04:29:15.577Z",
      "updated_at": "2026-10-27T04:29:15.577Z",
      "current_salary": 55000,
      "next_increment_date": "2027-02-28T18:30:00.000Z",
      "payroll": {
        "total_records": 0,
        "records": []
      }
    }
```

#### ➤ Get employee payroll configurations for a stat card
```
GET /api/employee-payroll/employee-payroll-config-stat-card
```
Returns configuration status counts in the `data` object: `pending`, `active`, and `expire`.

#### ➤ Get payroll dashboard statistics
```
GET /api/employee-payroll/payroll-dashboard-stats
```

#### ➤ Add company bank details
```
POST /api/company-bank-details
```

### Success Response
```json
{
    "success": true,
    "message": "Company bank added successfully.",
    "data": {
        "id": 1,
        "company_bank_name": "Kotak Mahindra Bank",
        "company_bank_account_no": "001234567890",
        "created_by": "AAM",
        "updated_by": "AAM",
        "created_at": "2026-10-27T11:11:23.351Z",
        "updated_at": "2026-10-27T11:11:23.351Z"
    }
}
```

#### ➤ Get all company bank details
```
GET /api/company-bank-details
```

### Success Response
```json
{
  "success": true,
  "count": 3,
  "data": [
    {
      "id": 3,
      "company_bank_name": "kotak",
      "company_bank_account_no": "9876543210",
      "created_by": "TMM",
      "updated_by": "TMM",
      "created_at": "2026-10-29T05:43:03.883Z",
      "updated_at": "2026-10-30T12:46:08.740Z",
      "status": false,
      "primary_account": false
    },
    {
      "id": 2,
      "company_bank_name": "SBI",
      "company_bank_account_no": "789654123",
      "created_by": "TMM",
      "updated_by": "TMM",
      "created_at": "2026-10-27T11:42:11.844Z",
      "updated_at": "2026-10-30T12:46:06.749Z",
      "status": true,
      "primary_account": true
    },
    {
      "id": 1,
      "company_bank_name": "HDFC Bank",
      "company_bank_account_no": "987654321",
      "created_by": "AAM",
      "updated_by": "TMM",
      "created_at": "2026-10-27T11:11:23.351Z",
      "updated_at": "2026-10-30T12:46:07.672Z",
      "status": true,
      "primary_account": false
    }
  ]
}
```

#### ➤ Get company bank details by ID
```
GET /api/company-bank-details/:id
```

### Success Response
```json
{
  "success": true,
  "data": {
    "id": 1,
    "company_bank_name": "HDFC Bank",
    "company_bank_account_no": "987654321",
    "created_by": "AAM",
    "updated_by": "TMM",
    "created_at": "2026-10-27T11:11:23.351Z",
    "updated_at": "2026-10-30T12:46:07.672Z",
    "status": true,
    "primary_account": false
  }
}
```

#### ➤ Update company bank details
```
PUT /api/company-bank-details/:id
```

### Success Response
```json
{
    "success": true,
    "message": "Company bank details updated successfully.",
    "data": {
        "id": 1,
        "company_bank_name": "HDFC Bank",
        "company_bank_account_no": "987654321012",
        "created_by": "AAM",
        "updated_by": "AAM",
        "created_at": "2026-10-27T11:11:23.351Z",
        "updated_at": "2026-10-27T11:27:13.545Z"
    }
}
```

#### ➤ Toggle company bank status
```
PATCH /api/company-bank-details/toggle/:id
```

### Success Response
```json
{
    "success": true,
    "message": "Company bank activated successfully.",
    "data": {
        "id": 1,
        "company_bank_name": "HDFC Bank",
        "company_bank_account_no": "987654321",
        "created_by": "AAM",
        "updated_by": "AAM",
        "created_at": "2026-10-27T11:11:23.351Z",
        "updated_at": "2026-10-27T11:47:50.184Z",
        "status": true
    }
}
```

#### ➤ Delete company bank details
```
DELETE /api/company-bank-details/:id
```

#### ➤ Download payroll settings as text
```
POST /api/payroll-settings/download-txt
```

#### ➤ Get payroll settings
```
GET /api/payroll-settings?payroll_month=10&payroll_year=2026
```


### Success Response
```json
{
  "success": true,
  "count": 2,
  "data": [
    {
      "Credit_Ac_No": "90290100002865",
      "Amount": "INR9029",
      "Transaction_Type": "C",
      "Payment_Details": "2437.19SALARY"
    },
    {
      "Serial_No": "002",
      "Debit_Ac": "987654321",
      "Amount": "12110.53",
      "IFSC_Code": "SBIN0010943",
      "Credit_Ac_No": "44534933078",
      "Beneficiary_Name": "AGHEDA SOHAM JITESHKUMAR",
      "Scheme_Type": "SB"
    }
  ]
}
```

-----------------------------------------------------------------------------------------------------------

#### Edit Logs

#### ➤ Get payroll edit logs
```
GET /api/payroll-logs
```

### Success Response
```json
{
  "success": true,
  "message": "Payroll edit logs fetched successfully",
  "data": [
    {
      "id": 99,
      "table_name": "salary_details",
      "record_id": 19,
      "username": "TKA",
      "edited_by": "TMM",
      "field_name": "next_increment_date",
      "old_value": "2026-10-01",
      "new_value": "2026-11-01",
      "created_at": "2026-10-28 16:11:26.018"
    },
    {
      "id": 98,
      "table_name": "employee_payroll_config",
      "record_id": 4,
      "username": "TKA",
      "edited_by": "TMM",
      "field_name": "status",
      "old_value": "expire",
      "new_value": "active",
      "created_at": "2026-10-28 16:11:26.018"
    },
  ]
}
```

#### ➤ Get leave edit logs
```
GET /api/leave-logs
```

### Success Response
```json
{
  "success": true,
  "message": "Leave edit logs fetched successfully",
  "data": [
    {
      "id": 14,
      "table_name": "employee_leaves",
      "record_id": 91,
      "username": "HHK",
      "edited_by": "TMM",
      "field_name": "status",
      "old_value": "Cancelled",
      "new_value": "Pending",
      "created_at": "2026-10-31 11:35:59.651"
    },
    {
      "id": 13,
      "table_name": "employee_leaves",
      "record_id": 91,
      "username": "HHK",
      "edited_by": "TMM",
      "field_name": "status",
      "old_value": "Pending",
      "new_value": "Cancelled",
      "created_at": "2026-10-31 11:35:57.670"
    }
  ]
}
```

#### ➤ Get meeting edit logs
```
GET /api/meeting-logs
```

### Success Response
```json
{
  "success": true,
  "message": "Meeting edit logs fetched successfully",
  "data": [
    {
      "id": 24,
      "record_id": 28,
      "username": "TTT",
      "edited_by": "TMM",
      "field_name": "meeting_cancelled_reason",
      "candidate_status": "new",
      "old_value": null,
      "new_value": "ASD",
      "created_at": "2026-10-30 17:04:45.396"
    },
    {
      "id": 23,
      "record_id": 28,
      "username": "TTT",
      "edited_by": "TMM",
      "field_name": "meeting_status",
      "candidate_status": "new",
      "old_value": "Schedule",
      "new_value": "Cancelled",
      "created_at": "2026-10-30 17:04:45.394"
    }
  ]
}
```

#### ➤ Get user data for session logs
```
GET /api/user-session-logs/user-data
```

### Success Response
```json
{
  "success": true,
  "message": "User session old data fetched successfully",
  "count": 44,
  "data": [
    {
      "user_id": 12,
      "username": "TMM",
      "first_name": "TASMI",
      "last_name": "MANGUKIYA",
      "image": "https://res.cloudinary.com/deurzzaeh/image/upload/v1782536366/employee_details/TMM/TASMI.webp",
      "last_seen_at": "2026-11-02 11:19:27.666",
      "status": "offline",
      "last_login_at": "2026-10-31 12:46:25.896",
      "last_logout_at": null,
      "operating_system": "Windows",
      "browser_name": "Chrome"
    },
    {
      "user_id": 7,
      "username": "TKA",
      "first_name": "TANVI",
      "last_name": "AMIPARA",
      "image": "https://res.cloudinary.com/deurzzaeh/image/upload/v1782469318/employee_details/TKA/TANVI.webp",
      "last_seen_at": "2026-11-02 11:18:59.577",
      "status": "offline",
      "last_login_at": "2026-11-02 11:18:59.577",
      "last_logout_at": null,
      "operating_system": "Windows",
      "browser_name": "Chrome"
    }
  ]
}
```

#### ➤ Get user session edit logs
```
GET /api/user-session-logs
```

### Success Response
```json
{
  "success": true,
  "message": "User session edit logs fetched successfully",
  "count": 50,
  "data": [
    {
      "id": 51,
      "table_name": "user_sessions",
      "record_id": 10,
      "username": "TMM",
      "edited_by": "TMM",
      "field_name": "last_login_at",
      "old_value": "2026-10-31 12:46:25.896",
      "new_value": "2026-11-02 11:19:27.666",
      "created_at": "2026-11-02 11:19:27.667"
    },
    {
      "id": 50,
      "table_name": "user_sessions",
      "record_id": 9,
      "username": "TKA",
      "edited_by": "TKA",
      "field_name": "last_logout_at",
      "old_value": null,
      "new_value": "2026-11-02 11:19:18.987",
      "created_at": "2026-11-02 11:19:18.994"
    }
  ]
}
```

-----------------------------------------------------------------------------------------------------------

## 8. Database Tables

HRMS tables (actual names from models):

```
Settings
* departments_hrms
* department_structure
* work_location
* shift_configurations
* bond_options
* category
* education
* device_configurations
* leave
* leave_prior
* master_password

Attendance
* attendance_sessions
* open_sessions
* mac_address
* mqtt_messages
* holidays
* employee_leaves

Employee
* personal_details
* identification_details
* employment_details
* bank_details
* educational_qualifications
* salary_details
* work_experience
* master_employee
* inactive_employee
* offer_letter_format
* offer_letter_format_history
* user_page_permissions

Recruitment / Status
* candidate
* candidate_source
* job_position
* status

Meetings
* meeting_schedule
* employee_meeting

Payroll
* payroll
* employee_payroll_config

Logs / Maintenance
* attendance_logs
* setting_edit_log
* calendar_edit_log
* employee_edit_log
* device_version_logs
* maintenance
* maintenance_features
```

-----------------------------------------------------------------------------------------------------------

## 9. Project Structure

```
ERPUPGRADEBACK/
├── api-documentation/
│   ├── filemanager/
│   │   ├── categoriesFolderStructure.md
│   │   ├── filemanagerAPI.md
│   │   ├── financialYearFileManager.md
│   │   ├── folderPermissions.md
│   │   └── projectFilemanager.md
│   ├── projectsheet/
│   │   └── projectPcbVersion.md
│   └── systemGuide.md
├── migrations/
│   ├── create_categories_table.sql
│   ├── create_departments_table.sql
│   └── setup.sql
├── node_modules/
├── src/
│   ├── config/
│   │   ├── cloudinary.controller.js
│   │   ├── db.js
│   │   ├── MQTTConnection.js
│   │   ├── multer.js
│   │   ├── socket.js
│   │   ├── swagger-auth-expire.js
│   │   └── swagger.js
│   ├── controllers/
│   │   ├── Attendance/
│   │   │   ├── AutoCloseAttendance/
│   │   │   │   └── AutoCloseAttendance.controller.js
│   │   │   ├── Calendar/
│   │   │   │   └── holiday.controller.js
│   │   │   ├── EmployeeRecord/
│   │   │   │   ├── employee_record.controller.js
│   │   │   │   └── EmployeeLeaves.controller.js
│   │   │   ├── Summary/
│   │   │   │   └── summary.controller.js
│   │   │   ├── attendance_session.controller.js
│   │   │   ├── mac_address.controller.js
│   │   │   ├── mqttMessages.controller.js
│   │   │   └── open_sessions.controller.js
│   │   ├── Auth/
│   │   │   ├── MasterPassword.controller.js
│   │   │   └── reset.controller.js
│   │   ├── Calendar/
│   │   │   └── GlobalCalendar.controller.js
│   │   ├── Candidate/
│   │   │   ├── candidate.controller.js
│   │   │   ├── candidate_source.controller.js
│   │   │   └── candidateBoardPreference.controller.js
│   │   ├── Download/
│   │   │   ├── downloadAttendance.controller.js
│   │   │   └── MonthlyAttendance.controller.js
│   │   ├── Employee/
│   │   │   ├── BankDetails.controller.js
│   │   │   ├── EducationalQualifications.controller.js
│   │   │   ├── employee.controller.js
│   │   │   ├── EmploymentDetails.controller.js
│   │   │   ├── IdentificationDetails.controller.js
│   │   │   ├── importExcel.controller.js
│   │   │   ├── MasterEmployee.controller.js
│   │   │   ├── offerLetterFormat.controller.js
│   │   │   ├── PersonalDetails.controller.js
│   │   │   ├── SalaryDetails.controller.js
│   │   │   └── WorkExperience.controller.js
│   │   ├── filemanager/
│   │   │   ├── CreateApi/
│   │   │   │   ├── createshortcut.js
│   │   │   │   ├── folder.js
│   │   │   │   ├── googledocs.js
│   │   │   │   ├── googleShareHelpers.js
│   │   │   │   ├── googlesheet.js
│   │   │   │   └── myFolder.js
│   │   │   ├── categoriesFolderStructure.controller.js
│   │   │   ├── fileManager.controller.js
│   │   │   ├── fileManagerpermission.controller.js
│   │   │   ├── fileManagerSetting.controller.js
│   │   │   ├── financialYearFileManager.controller.js
│   │   │   ├── projectFileManager.controller.js
│   │   │   └── sharedWithMe.controller.js
│   │   ├── history/
│   │   │   ├── attendance_logs.controller.js
│   │   │   ├── auditLog.controller.js
│   │   │   ├── calendar_log.controller.js
│   │   │   ├── device_version_logs.controller.js
│   │   │   ├── employee_edit_log.controller.js
│   │   │   ├── leave_edit_log.controller.js
│   │   │   ├── meeting_edit_log.controller.js
│   │   │   ├── payroll_edit_log.controller.js
│   │   │   ├── setting_edit_log.controller.js
│   │   │   ├── task-list-history.controller.js
│   │   │   └── user_session_edit_log.controller.js
│   │   ├── JobPosition/
│   │   │   └── jobPosition.controller.js
│   │   ├── Maintenance/
│   │   │   └── Maintenance.controller.js
│   │   ├── MeetingSchedule/
│   │   │   ├── employeeMeeting.controller.js
│   │   │   └── meetingSchedule.controller.js
│   │   ├── Payroll/
│   │   │   ├── companyBank.controller.js
│   │   │   ├── downloadPayroll.controller.js
│   │   │   ├── employee_payroll_config.controller.js
│   │   │   ├── monthlyEmployeeReport.controller.js
│   │   │   ├── payroll.controller.js
│   │   │   ├── payrollConfigExpiry.controller.js
│   │   │   ├── payrollReport.controller.js
│   │   │   ├── payrollSettings.controller.js
│   │   │   └── payrollSettingsDownloadLog.controller.js
│   │   ├── projectsheet/
│   │   │   ├── client.controller.js
│   │   │   ├── customProcess.controller.js
│   │   │   ├── pcb.controller.js
│   │   │   ├── pcbCustomProcess.controller.js
│   │   │   ├── production.controller.js
│   │   │   ├── project.controller.js
│   │   │   ├── projectPcbVersion.controller.js
│   │   │   ├── projectProcessChecked.controller.js
│   │   │   └── updateProject.controller.js
│   │   ├── r2r/
│   │   │   ├── bom.controller.js
│   │   │   ├── issue.controller.js
│   │   │   ├── qtyReservation.controller.js
│   │   │   ├── qtyReservationExpire.controller.js
│   │   │   ├── r2rImage.controller.js
│   │   │   ├── receiveIssueResponse.controller.js
│   │   │   ├── requirement.controller.js
│   │   │   └── requirementEditLog.controller.js
│   │   ├── services/
│   │   │   └── mqttAckService.controller.js
│   │   ├── settings/
│   │   │   ├── Bond.controller.js
│   │   │   ├── category.controller.js
│   │   │   ├── Deparments.controller.js
│   │   │   ├── department.controller.js
│   │   │   ├── DepartmentStructure.controller.js
│   │   │   ├── DeviceConfiguration.controller.js
│   │   │   ├── education.controller.js
│   │   │   ├── financial-year.controller.js
│   │   │   ├── Leave.controller.js
│   │   │   ├── Leave_prior.controller.js
│   │   │   ├── Location.controller.js
│   │   │   ├── noImage.controller.js
│   │   │   ├── setting.controller.js
│   │   │   ├── ShiftConfigurations.controller.js
│   │   │   └── unit.controller.js
│   │   ├── status/
│   │   │   └── status.controller.js
│   │   ├── systemGuide/
│   │   │   ├── guideBlock.controller.js
│   │   │   ├── guideDocument.controller.js
│   │   │   ├── guideElement.controller.js
│   │   │   ├── guideMedia.controller.js
│   │   │   ├── guideModule.controller.js
│   │   │   ├── guidePage.controller.js
│   │   │   ├── guidePermission.controller.js
│   │   │   ├── guideRevision.controller.js
│   │   │   ├── guideSection.controller.js
│   │   │   ├── guideTab.controller.js
│   │   │   └── guideVersion.controller.js
│   │   ├── timesheet/
│   │   │   ├── AutoStopTimesheet.controller.js
│   │   │   ├── category.controller.js
│   │   │   ├── categoryType.controller.js
│   │   │   ├── Durationreport.cotroller.js
│   │   │   ├── task.controller.js
│   │   │   ├── taskStatus.controller.js
│   │   │   └── timesheet.controller.js
│   │   ├── users/
│   │   │   ├── userPagePermission.controller.js
│   │   │   └── userSession.controller.js
│   │   ├── config.controller.js
│   │   └── upload.controller.js
│   ├── middleware/
│   │   ├── auth.js
│   │   ├── cache.js
│   │   ├── cloudinaryUpload.js
│   │   ├── error.middleware.js
│   │   ├── images.js
│   │   ├── printAgentAuth.js
│   │   ├── sanitizeBody.middleware.js
│   │   └── upload.js
│   ├── models/
│   │   ├── Attendance/
│   │   │   ├── AutoCloseAttendance/
│   │   │   │   └── AutoCloseAttendance.model.js
│   │   │   ├── Calendar/
│   │   │   │   └── holiday.model.js
│   │   │   ├── EmployeeRecord/
│   │   │   │   ├── employee_record.model.js
│   │   │   │   └── EmployeeLeaves.model.js
│   │   │   ├── Summary/
│   │   │   │   └── summary.model.js
│   │   │   ├── attendance_session.model.js
│   │   │   ├── mac_address.model.js
│   │   │   ├── mqttMessages.model.js
│   │   │   └── open_sessions.model.js
│   │   ├── auth/
│   │   │   └── MasterPassword.model.js
│   │   ├── Calendar/
│   │   │   └── GlobalCalendar.model.js
│   │   ├── Candidate/
│   │   │   ├── candidate.models.js
│   │   │   ├── candidate_source.model.js
│   │   │   └── candidateBoardPreference.model.js
│   │   ├── Download/
│   │   │   └── MonthlyAttendance.model.js
│   │   ├── Employee/
│   │   │   ├── BankDetails.model.js
│   │   │   ├── EducationalQualifications.models.js
│   │   │   ├── employee.model.js
│   │   │   ├── EmploymentDetails.model.js
│   │   │   ├── IdentificationDetails.model.js
│   │   │   ├── inactive_employee.model.js
│   │   │   ├── MasterEmployee.model.js
│   │   │   ├── offerLetterFormat.model.js
│   │   │   ├── PersonalDetails.model.js
│   │   │   ├── SalaryDetails.models.js
│   │   │   └── WorkExperience.model.js
│   │   ├── filemanager/
│   │   │   ├── categoriesFolderStructure.model.js
│   │   │   ├── fileManager.model.js
│   │   │   ├── fileManagerItemFolderUsers.model.js
│   │   │   ├── fileManagerLog.model.js
│   │   │   ├── fileManagerPermission.model.js
│   │   │   ├── fileManagerScopes.js
│   │   │   ├── fileManagerSetting.model.js
│   │   │   ├── fileManagerUnified.schema.js
│   │   │   ├── financialYearFileManager.model.js
│   │   │   └── projectFileManager.model.js
│   │   ├── history/
│   │   │   ├── attendance_logs.model.js
│   │   │   ├── auditLog.model.js
│   │   │   ├── calendar_log.model.js
│   │   │   ├── device_version_logs.model.js
│   │   │   ├── employee_edit_log.model.js
│   │   │   ├── leave_edit_log.model.js
│   │   │   ├── meeting_edit_log.model.js
│   │   │   ├── payroll_edit_log.model.js
│   │   │   ├── setting_edit_log.model.js
│   │   │   ├── task-list-history.model.js
│   │   │   ├── Tasklog.model.js
│   │   │   ├── timesheet-log.model.js
│   │   │   └── user_session_edit_log.model.js
│   │   ├── JobPosition/
│   │   │   └── jobPosition.models.js
│   │   ├── Maintenance/
│   │   │   └── Maintenance.model.js
│   │   ├── MeetingSchedule/
│   │   │   ├── employeeMeeting.models.js
│   │   │   └── meetingSchedule.models.js
│   │   ├── Payroll/
│   │   │   ├── companyBank.model.js
│   │   │   ├── employee_payroll_config.model.js
│   │   │   ├── monthlyEmployeeReport.model.js
│   │   │   ├── payroll.model.js
│   │   │   ├── payrollReport.model.js
│   │   │   ├── payrollSettings.model.js
│   │   │   └── payrollSettingsDownloadLog.model.js
│   │   ├── projectsheet/
│   │   │   ├── client.model.js
│   │   │   ├── customProcess.model.js
│   │   │   ├── pcb.model.js
│   │   │   ├── pcbCustomProcess.model.js
│   │   │   ├── pcbLog.model.js
│   │   │   ├── production.model.js
│   │   │   ├── productionLog.model.js
│   │   │   ├── project.model.js
│   │   │   ├── projectLog.model.js
│   │   │   ├── projectPcbVersion.model.js
│   │   │   ├── projectProcessChecked.model.js
│   │   │   └── updateProject.model.js
│   │   ├── r2r/
│   │   │   ├── bomGoogleSheet.model.js
│   │   │   ├── issue.model.js
│   │   │   ├── qtyReservation.model.js
│   │   │   ├── r2rTempBomImage.model.js
│   │   │   ├── r2rTempRequirement.model.js
│   │   │   ├── receiveIssueResponse.model.js
│   │   │   ├── requirement.model.js
│   │   │   ├── requirementEditLog.model.js
│   │   │   └── requirementStatus.model.js
│   │   ├── settings/
│   │   │   ├── Bond.model.js
│   │   │   ├── category.model.js
│   │   │   ├── Deparments.model.js
│   │   │   ├── department.model.js
│   │   │   ├── Department_structure.model.js
│   │   │   ├── DeviceConfigurations.model.js
│   │   │   ├── education.model.js
│   │   │   ├── financial-year.model.js
│   │   │   ├── Leave.model.js
│   │   │   ├── Leave_prior.model.js
│   │   │   ├── Location.model.js
│   │   │   ├── noImage.model.js
│   │   │   ├── setting.model.js
│   │   │   ├── ShiftConfigurations.model.js
│   │   │   └── unit.model.js
│   │   ├── status/
│   │   │   └── status.model.js
│   │   ├── systemGuide/
│   │   │   ├── guideBlock.model.js
│   │   │   ├── guideDocument.model.js
│   │   │   ├── guideElement.model.js
│   │   │   ├── guideMedia.model.js
│   │   │   ├── guideModule.model.js
│   │   │   ├── guidePage.model.js
│   │   │   ├── guidePermission.model.js
│   │   │   ├── guideRevision.model.js
│   │   │   ├── guideSection.model.js
│   │   │   ├── guideTab.model.js
│   │   │   ├── guideVersion.model.js
│   │   │   └── systemGuide.schema.js
│   │   ├── timesheet/
│   │   │   ├── category.model.js
│   │   │   ├── categoryType.model.js
│   │   │   ├── Durationreport.model.js
│   │   │   ├── task.model.js
│   │   │   ├── taskStatus.model.js
│   │   │   ├── taskStatusHistory.model.js
│   │   │   └── timesheet.model.js
│   │   └── users/
│   │       ├── userPagePermission.model.js
│   │       └── userSession.model.js
│   ├── routes/
│   │   ├── Attendance/
│   │   │   ├── Calendar/
│   │   │   │   └── holiday.router.js
│   │   │   ├── EmployeeRecord/
│   │   │   │   ├── employee_record.router.js
│   │   │   │   └── EmployeeLeaves.router.js
│   │   │   ├── Summary/
│   │   │   │   └── summary.router.js
│   │   │   ├── attendance_session.router.js
│   │   │   ├── mac_address.router.js
│   │   │   ├── mqttMessages.router.js
│   │   │   └── open_sessions.router.js
│   │   ├── auth/
│   │   │   ├── MasterPassword.router.js
│   │   │   └── reset.router.js
│   │   ├── Calendar/
│   │   │   └── GlobalCalendar.router.js
│   │   ├── Candidate/
│   │   │   ├── candidate.router.js
│   │   │   └── candidate_source.routes.js
│   │   ├── download/
│   │   │   ├── downloadAttendance.router.js
│   │   │   └── MonthlyAttendance.router.js
│   │   ├── Employee/
│   │   │   ├── BankDetails.router.js
│   │   │   ├── EducationalQualifications.router.js
│   │   │   ├── employee.router.js
│   │   │   ├── EmploymentDetails.router.js
│   │   │   ├── identification_details.router.js
│   │   │   ├── importExcel.router.js
│   │   │   ├── MasterEmployee.router.js
│   │   │   ├── offerLetterFormat.router.js
│   │   │   ├── PersonalDetails.router.js
│   │   │   ├── SalaryDetails.router.js
│   │   │   └── WorkExperience.router.js
│   │   ├── filemanager/
│   │   │   ├── categoriesFolderStructure.routes.js
│   │   │   ├── fileManager.routes.js
│   │   │   ├── fileManagerSetting.routes.js
│   │   │   ├── financialYearFileManager.routes.js
│   │   │   └── projectFileManager.routes.js
│   │   ├── history/
│   │   │   ├── attendance_logs.router.js
│   │   │   ├── auditLog.routes.js
│   │   │   ├── calendar_log.router.js
│   │   │   ├── device_version_logs.router.js
│   │   │   ├── employee_edit_log.router.js
│   │   │   ├── leave_edit_log.routes.js
│   │   │   ├── meeting_edit_log.routes.js
│   │   │   ├── payroll_edit_log.routes.js
│   │   │   ├── setting_edit_log.routes.js
│   │   │   ├── task-list-history.routes.js
│   │   │   └── user_session_edit_log.routes.js
│   │   ├── JobPosition/
│   │   │   └── jobPosition.routes.js
│   │   ├── Maintenance/
│   │   │   └── Maintenance.router.js
│   │   ├── MeetingSchedule/
│   │   │   ├── employeeMeeting.router.js
│   │   │   └── meetingSchedule.routes.js
│   │   ├── Payroll/
│   │   │   ├── companyBank.router.js
│   │   │   ├── employee_payroll_config.router.js
│   │   │   ├── payroll.router.js
│   │   │   ├── payrollReport.router.js
│   │   │   └── payrollSettings.routes.js
│   │   ├── projectsheet/
│   │   │   ├── client.routes.js
│   │   │   ├── pcb.routes.js
│   │   │   ├── production.routes.js
│   │   │   ├── project.routes.js
│   │   │   ├── projectPcbVersion.routes.js
│   │   │   ├── projectProcessChecked.routes.js
│   │   │   └── updateProject.routes.js
│   │   ├── r2r/
│   │   │   ├── bom.routes.js
│   │   │   ├── issue.routes.js
│   │   │   ├── qtyReservation.routes.js
│   │   │   ├── r2rImage.routes.js
│   │   │   ├── receiveIssueResponse.routes.js
│   │   │   ├── requirement.routes.js
│   │   │   └── requirementEditLog.routes.js
│   │   ├── settings/
│   │   │   ├── Bond.router.js
│   │   │   ├── category.router.js
│   │   │   ├── Deparments.router.js
│   │   │   ├── department.routes.js
│   │   │   ├── DepartmentStructure.router.js
│   │   │   ├── DeviceConfigurations.router.js
│   │   │   ├── education.router.js
│   │   │   ├── financial-year.routes.js
│   │   │   ├── Leave.router.js
│   │   │   ├── Leave_prior.router.js
│   │   │   ├── Location.router.js
│   │   │   ├── noImage.routes.js
│   │   │   ├── setting.routes.js
│   │   │   ├── ShiftConfigurations.router.js
│   │   │   └── unit.routes.js
│   │   ├── status/
│   │   │   └── status.router.js
│   │   ├── systemGuide/
│   │   │   ├── guideBlock.routes.js
│   │   │   ├── guideDocument.routes.js
│   │   │   ├── guideElement.routes.js
│   │   │   ├── guideMedia.routes.js
│   │   │   ├── guideModule.routes.js
│   │   │   ├── guidePage.routes.js
│   │   │   ├── guidePermission.routes.js
│   │   │   ├── guideRevision.routes.js
│   │   │   ├── guideSection.routes.js
│   │   │   ├── guideTab.routes.js
│   │   │   ├── guideVersion.routes.js
│   │   │   └── systemGuide.routes.js
│   │   ├── timesheet/
│   │   │   ├── category.routes.js
│   │   │   ├── categoryType.routes.js
│   │   │   ├── task.routes.js
│   │   │   ├── taskStatus.routes.js
│   │   │   └── timesheet.routes.js
│   │   ├── users/
│   │   │   ├── userPagePermission.routes.js
│   │   │   └── userSession.router.js
│   │   └── index.js
│   ├── services/
│   │   └── filemanager/
│   │       ├── diskChildren.js
│   │       ├── googleAuth.service.js
│   │       ├── googleDriveFolders.service.js
│   │       ├── googleFile.service.js
│   │       ├── thumbnail.route.js
│   │       └── thumbnail.service.js
│   ├── utils/
│   │   ├── notification/
│   │   │   ├── payrollStatusNotify.js
│   │   │   ├── r2rDesktopNotify.js
│   │   │   ├── readNotificationNotify.js
│   │   │   ├── receiveIssueNotify.js
│   │   │   └── requirementStatusNotify.js
│   │   ├── audit.utils.js
│   │   ├── dataScope.utils.js
│   │   ├── fileManagerCreatedBy.js
│   │   ├── fileManagerPublicId.js
│   │   ├── financial-year.utils.js
│   │   ├── generatePassword.js
│   │   ├── googleAppsScript.utils.js
│   │   ├── mailer.js
│   │   ├── paginatedList.utils.js
│   │   ├── payrollEncryption.js
│   │   ├── productionStatus.utils.js
│   │   ├── project.utils.js
│   │   ├── projectProcessChecked.utils.js
│   │   ├── r2rImageStorage.js
│   │   ├── requirement.utils.js
│   │   ├── time.utils.js
│   │   ├── timesheetOverlap.utils.js
│   │   ├── userPermission.utils.js
│   │   └── worker.utils.js
│   ├── workers/
│   │   ├── README.md
│   │   └── timesheet-calculations.worker.js
│   ├── database.js
│   ├── index.js
│   └── server.js
├── uploads/
├── .env
├── .gitignore
├── err.txt
├── HRMS.md
├── package-lock.json
├── package.json
└── README.md
```

-----------------------------------------------------------------------------------------------------------

## 10. MQTT Integration

### Connection Flow

```
1. Backend connects to MQTT broker with credentials
2. Backend subscribes to device topics (+/pub, +/handshake)
3. Devices publish messages to their topics
4. Backend receives and processes messages
5. Backend publishes ACK responses
```

### Device Communication

**Device → Backend (Attendance):**
```json
Topic: 14335C698624/pub
{
  "timestamp": "2026-06-12T09:43:18Z",
  "message_id": 169471,
  "rfid_uid": "0011669103",
  "mac_address": "14335C698624"
}
```

**Backend → Device (ACK):**
```json
Topic: 14335C698624/sub
{
  "ack": true,
  "message_id": 169471,
  "status": "processed"
}
```

See [MQTT_INTEGRATION.md](MQTT_INTEGRATION.md) for detailed MQTT documentation.

-----------------------------------------------------------------------------------------------------------

## 11. Security

### Authentication & Authorization
- JWT token-based authentication
- Session management with secure cookies
- Role-based access control (RBAC)

### Data Security
- SSL/TLS encryption for MQTT communications
- Encrypted database connections
- Password hashing with bcrypt
- Input validation and sanitization
- SQL injection prevention

### Best Practices
- Store credentials in environment variables
- Never commit `.env` file to repository
- Use `.env.example` as template
- Rotate credentials regularly
- Enable HTTPS in production
- Use strong passwords (minimum 16 characters)

-----------------------------------------------------------------------------------------------------------

## 12. Testing

### Run Tests
```bash
npm test
```

### Run with Coverage
```bash
npm run test:coverage
```

### Test Types
- Unit tests - Individual component testing
- Integration tests - MQTT and database integration
- End-to-end tests - Complete flow testing

-----------------------------------------------------------------------------------------------------------

## 13. Monitoring & Logs

### Log Levels
```
DEBUG   - Detailed debugging information
INFO    - Informational messages
WARN    - Warning messages
ERROR   - Error messages
FATAL   - Fatal errors
```

### Enable Debug Logging
```bash
DEBUG=hrms:* npm start
```

### Log Files
- Application logs stored in `logs/` directory
- MQTT connection logs
- Database query logs
- API request logs

-----------------------------------------------------------------------------------------------------------

## 14. Troubleshooting

### Common Issues

**MQTT Connection Failed**
- Check broker host and port
- Verify credentials
- Ensure network connectivity
- See [MQTT_INTEGRATION.md - Troubleshooting](MQTT_INTEGRATION.md#troubleshooting)

**Database Connection Error**
- Verify PostgreSQL is running
- Check database credentials
- Confirm database exists
- Check network connectivity

**File Upload Issues**
- Verify Cloudinary credentials
- Check upload folder permissions
- Ensure file size limits

**Employee Not Found**
- Verify RFID UID is registered
- Check employee record exists
- Confirm RFID format

-----------------------------------------------------------------------------------------------------------

## 15. Documentation

- [MQTT_INTEGRATION.md](MQTT_INTEGRATION.md) - Detailed MQTT setup and integration guide
- [Attendance.md](Attendance.md) - Detailed attendance 

-----------------------------------------------------------------------------------------------------------

## 16. Contributing

1. Create a feature branch
2. Make your changes
3. Test thoroughly
4. Submit pull request

### Code Standards
- Use consistent naming conventions
- Add comments for complex logic
- Follow Node.js best practices
- Use async/await for asynchronous operations

-----------------------------------------------------------------------------------------------------------

## 17. Dependencies

### Core
- **express** - Web framework
- **node-postgres (pg)** - PostgreSQL client
- **mqtt** - MQTT client library
- **socket.io** - Real-time communication

### File Upload
- **cloudinary** - Cloud storage service
- **multer** - File upload middleware

### Utilities
- **dotenv** - Environment variable management
- **cors** - Cross-origin resource sharing
- **helmet** - Security headers

### Development
- **jest** - Testing framework
- **nodemon** - Auto-reload during development
- **eslint** - Code linting

See `package.json` for complete dependency list.

-----------------------------------------------------------------------------------------------------------

## 18. Environment Variables

Create `.env` file with these variables:

```env
# Server
PORT=8000
NODE_ENV=development

# Database
DB_HOST=localhost
DB_PORT=5432
DB_NAME=hrms_db
DB_USER=postgres
DB_PASSWORD=password

# MQTT
MQTT_HOST=broker.hivemq.cloud
MQTT_PORT=8883
MQTT_USER=username
MQTT_PASSWORD=password
MQTT_USE_SSL=true
MQTT_CLIENT_ID=attendance_server

# Cloudinary
CLOUDINARY_NAME=name
CLOUDINARY_API_KEY=key
CLOUDINARY_API_SECRET=secret

# Security
JWT_SECRET=your_secret_key
SESSION_SECRET=your_session_secret
```

-----------------------------------------------------------------------------------------------------------

## 19. Performance Optimization

- Database query optimization with indexes
- Connection pooling for database
- Message caching for frequently accessed data
- Rate limiting on API endpoints
- Compression for API responses

-----------------------------------------------------------------------------------------------------------

## 20. Support & Contact

For issues, questions, or suggestions:
- Open an issue on the repository
- Contact the development team
- Check existing documentation

-----------------------------------------------------------------------------------------------------------

## 21. Acknowledgments

- MQTT.js for MQTT client implementation
- Express.js for web framework
- PostgreSQL for database
- HiveMQ for MQTT broker service

-----------------------------------------------------------------------------------------------------------
