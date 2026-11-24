-- Create categories table for tree structure
CREATE TABLE IF NOT EXISTS categories (
    id SERIAL PRIMARY KEY,
    parent_id INTEGER REFERENCES categories(id) ON DELETE CASCADE,
    letter VARCHAR(1),           -- specific to top-level nodes often
    name VARCHAR(255) NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Index for faster tree traversal lookups
CREATE INDEX IF NOT EXISTS idx_categories_parent_id ON categories(parent_id);

-- Seed Data (Initial Structure)
-- 1. Management (M)
INSERT INTO categories (letter, name, is_active) 
VALUES ('M', 'Management', TRUE);

-- Get ID of Management to insert children (assuming sequential IDs for initial seed or use nested subqueries)
-- Using a DO block or assuming init script runs on empty DB. For simple migration file, simple inserts:

-- Sub-categories for Management (parent_id = 1)
INSERT INTO categories (parent_id, name, is_active) VALUES 
((SELECT id FROM categories WHERE name = 'Management' AND parent_id IS NULL LIMIT 1), 'Executive', TRUE),
((SELECT id FROM categories WHERE name = 'Management' AND parent_id IS NULL LIMIT 1), 'Operational', TRUE);

-- 2. Production (P)
INSERT INTO categories (letter, name, is_active) 
VALUES ('P', 'Production', TRUE);

-- Sub-categories for Production (parent_id = 2)
INSERT INTO categories (parent_id, name, is_active) VALUES 
((SELECT id FROM categories WHERE name = 'Production' AND parent_id IS NULL LIMIT 1), 'Assembly', TRUE),
((SELECT id FROM categories WHERE name = 'Production' AND parent_id IS NULL LIMIT 1), 'Quality Control', TRUE);

-- 3. Human Resources (H)
INSERT INTO categories (letter, name, is_active) 
VALUES ('H', 'Human Resources', TRUE);
