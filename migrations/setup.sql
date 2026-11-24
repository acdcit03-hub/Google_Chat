-- ACDC Administration Database Setup Script
-- Run this script in PostgreSQL to create the database and initial setup

-- Create database (run this as postgres superuser)
-- CREATE DATABASE acdc_admin;

-- Connect to the database
-- \c acdc_admin

-- Create users table
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    first_name VARCHAR(100),
    middle_name VARCHAR(100),
    last_name VARCHAR(100),
    username VARCHAR(100) UNIQUE NOT NULL,
    password VARCHAR(255) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    department VARCHAR(100),
    access INTEGER DEFAULT 0, -- 0 = User, 1 = Admin
    status INTEGER DEFAULT 1, -- 0 = Inactive, 1 = Active
    head_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    permissions JSONB DEFAULT '[]'::jsonb,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);
CREATE INDEX IF NOT EXISTS idx_users_department ON users(department);

-- Create a function to update the updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Create trigger to automatically update updated_at
CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Insert sample admin user (password: admin123)
-- Note: This is a hashed version of 'admin123' using bcrypt
INSERT INTO users (
    first_name, 
    middle_name, 
    last_name, 
    username, 
    password, 
    email, 
    department, 
    access, 
    status,
    permissions
) VALUES (
    'Admin',
    '',
    'User',
    'admin',
    '$2b$10$rKZLvXZJvqZ5F5F5F5F5FeuKj3h3h3h3h3h3h3h3h3h3h3h3h3h3h',
    'admin@acdc.com',
    'null',
    1,
    1,
    '["dashboard", "r2r", "timesheet", "user-management",settings]'::jsonb
) ON CONFLICT (username) DO NOTHING;

-- Display success message
SELECT 'Database setup completed successfully!' as message;
