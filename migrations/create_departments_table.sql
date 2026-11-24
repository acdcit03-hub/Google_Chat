-- Create departments table
CREATE TABLE IF NOT EXISTS departments (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) UNIQUE NOT NULL,
    description TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create index for faster name lookups
CREATE INDEX IF NOT EXISTS idx_departments_name ON departments(name);

-- Seed initial departments
INSERT INTO departments (name, description) VALUES 
('IT', 'Information Technology and Systems'),

ON CONFLICT (name) DO NOTHING;
