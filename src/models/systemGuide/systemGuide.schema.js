import { pool } from '../../config/db.js';

/**
 * Create all System Guide tables (modules → pages → … → permissions).
 */
export async function initializeSystemGuideTables() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS guide_modules (
            id SERIAL PRIMARY KEY,
            module_key VARCHAR(100) NOT NULL UNIQUE,
            title VARCHAR(255) NOT NULL,
            slug VARCHAR(255) NOT NULL UNIQUE,
            icon VARCHAR(100),
            route VARCHAR(255),
            description TEXT,
            sort_order INT DEFAULT 0,
            is_active BOOLEAN DEFAULT TRUE,
            auto_generated BOOLEAN DEFAULT FALSE,
            created_by INT,
            updated_by INT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS guide_pages (
            id SERIAL PRIMARY KEY,
            module_id INT NOT NULL REFERENCES guide_modules(id) ON DELETE CASCADE,
            page_key VARCHAR(100) NOT NULL,
            title VARCHAR(255) NOT NULL,
            slug VARCHAR(255) NOT NULL,
            route VARCHAR(255),
            description TEXT,
            sort_order INT DEFAULT 0,
            is_active BOOLEAN DEFAULT TRUE,
            auto_generated BOOLEAN DEFAULT FALSE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE (module_id, page_key),
            UNIQUE (module_id, slug)
        );

        CREATE TABLE IF NOT EXISTS guide_tabs (
            id SERIAL PRIMARY KEY,
            page_id INT NOT NULL REFERENCES guide_pages(id) ON DELETE CASCADE,
            tab_key VARCHAR(100) NOT NULL,
            title VARCHAR(255) NOT NULL,
            sort_order INT DEFAULT 0,
            is_active BOOLEAN DEFAULT TRUE,
            auto_generated BOOLEAN DEFAULT FALSE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE (page_id, tab_key)
        );

        CREATE TABLE IF NOT EXISTS guide_sections (
            id SERIAL PRIMARY KEY,
            page_id INT NOT NULL REFERENCES guide_pages(id) ON DELETE CASCADE,
            tab_id INT REFERENCES guide_tabs(id) ON DELETE SET NULL,
            title VARCHAR(255) NOT NULL,
            slug VARCHAR(255),
            description TEXT,
            sort_order INT DEFAULT 0,
            is_active BOOLEAN DEFAULT TRUE,
            auto_generated BOOLEAN DEFAULT FALSE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS guide_elements (
            id SERIAL PRIMARY KEY,
            page_id INT NOT NULL REFERENCES guide_pages(id) ON DELETE CASCADE,
            tab_id INT REFERENCES guide_tabs(id) ON DELETE SET NULL,
            section_id INT REFERENCES guide_sections(id) ON DELETE SET NULL,
            element_key VARCHAR(100) NOT NULL,
            element_type VARCHAR(50) NOT NULL,
            label VARCHAR(255),
            field_name VARCHAR(100),
            action_name VARCHAR(100),
            route VARCHAR(255),
            metadata JSONB DEFAULT '{}'::jsonb,
            sort_order INT DEFAULT 0,
            is_active BOOLEAN DEFAULT TRUE,
            auto_generated BOOLEAN DEFAULT FALSE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS guide_versions (
            id SERIAL PRIMARY KEY,
            version_key VARCHAR(50) NOT NULL UNIQUE,
            version_name VARCHAR(100) NOT NULL,
            description TEXT,
            is_active BOOLEAN DEFAULT TRUE,
            is_default BOOLEAN DEFAULT FALSE,
            created_by INT,
            updated_by INT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS guide_documents (
            id SERIAL PRIMARY KEY,
            module_id INT REFERENCES guide_modules(id) ON DELETE SET NULL,
            page_id INT REFERENCES guide_pages(id) ON DELETE SET NULL,
            tab_id INT REFERENCES guide_tabs(id) ON DELETE SET NULL,
            section_id INT REFERENCES guide_sections(id) ON DELETE SET NULL,
            version_id INT REFERENCES guide_versions(id) ON DELETE SET NULL,
            title VARCHAR(255) NOT NULL,
            slug VARCHAR(255) NOT NULL,
            summary TEXT,
            status VARCHAR(50) DEFAULT 'draft',
            sort_order INT DEFAULT 0,
            created_by INT,
            updated_by INT,
            published_by INT,
            published_at TIMESTAMP,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS guide_blocks (
            id SERIAL PRIMARY KEY,
            document_id INT NOT NULL REFERENCES guide_documents(id) ON DELETE CASCADE,
            parent_block_id INT REFERENCES guide_blocks(id) ON DELETE CASCADE,
            block_type VARCHAR(50) NOT NULL,
            content JSONB DEFAULT '{}'::jsonb,
            source_type VARCHAR(100),
            source_id INT,
            auto_generated BOOLEAN DEFAULT FALSE,
            sort_order INT DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS guide_media (
            id SERIAL PRIMARY KEY,
            media_type VARCHAR(50) NOT NULL,
            provider VARCHAR(50) DEFAULT 'storage',
            file_name VARCHAR(255),
            storage_name VARCHAR(255),
            relative_path VARCHAR(500),
            url TEXT,
            mime_type VARCHAR(100),
            size BIGINT,
            width INT,
            height INT,
            duration NUMERIC(10,2),
            thumbnail_path TEXT,
            alt_text VARCHAR(255),
            metadata JSONB DEFAULT '{}'::jsonb,
            created_by INT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS guide_revisions (
            id SERIAL PRIMARY KEY,
            document_id INT NOT NULL REFERENCES guide_documents(id) ON DELETE CASCADE,
            version_number INT NOT NULL,
            snapshot JSONB NOT NULL,
            change_note TEXT,
            created_by INT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS guide_permissions (
            id SERIAL PRIMARY KEY,
            module_id INT REFERENCES guide_modules(id) ON DELETE CASCADE,
            permission_key VARCHAR(50) NOT NULL,
            role_id INT,
            user_id INT,
            is_allowed BOOLEAN DEFAULT TRUE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_guide_modules_active
            ON guide_modules(is_active, sort_order);
        CREATE INDEX IF NOT EXISTS idx_guide_pages_module
            ON guide_pages(module_id, sort_order);
        CREATE INDEX IF NOT EXISTS idx_guide_tabs_page
            ON guide_tabs(page_id, sort_order);
        CREATE INDEX IF NOT EXISTS idx_guide_sections_page
            ON guide_sections(page_id, sort_order);
        CREATE INDEX IF NOT EXISTS idx_guide_elements_page
            ON guide_elements(page_id, sort_order);
        CREATE INDEX IF NOT EXISTS idx_guide_documents_slug
            ON guide_documents(slug);
        CREATE INDEX IF NOT EXISTS idx_guide_blocks_document
            ON guide_blocks(document_id, sort_order);
        CREATE INDEX IF NOT EXISTS idx_guide_revisions_document
            ON guide_revisions(document_id, version_number);
        CREATE INDEX IF NOT EXISTS idx_guide_permissions_module
            ON guide_permissions(module_id, permission_key);
    `);

    console.log('✅ System Guide tables ready');
}

export default { initializeSystemGuideTables };
