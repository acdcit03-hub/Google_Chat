import { pool } from './config/db.js';

export const initializeTableSafely = async (tableName, initializer) => {
    try {
        await initializer();
    } catch (error) {
        console.warn(`⚠️ Failed to initialize ${tableName}:`, error.message);
    }
};

// Initialize database tables
const initializeDatabase = async () => {
    try {




        // User–page permission table: one row per (user_id, page_id) for view/add/edit/delete
        await pool.query(`
            CREATE TABLE IF NOT EXISTS user_page_permissions (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    username VARCHAR(100) DEFAULT '',
    location_id INTEGER NOT NULL ,
    location_name VARCHAR(100) NOT NULL,
    page_id VARCHAR(100) NOT NULL,
    label VARCHAR(255) DEFAULT '',

    can_view BOOLEAN DEFAULT false,
    can_add BOOLEAN DEFAULT false,
    can_edit BOOLEAN DEFAULT false,
    can_delete BOOLEAN DEFAULT false,
    can_head BOOLEAN DEFAULT false,
    can_export BOOLEAN DEFAULT false,
    can_organization BOOLEAN DEFAULT false,

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    UNIQUE(user_id, location_id, page_id)
);
        `);

        // Migration: add can_head, can_export, label, username to user_page_permissions if missing
        await pool.query(`
            DO $$
            BEGIN
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'user_page_permissions' AND column_name = 'can_head') THEN
                    ALTER TABLE user_page_permissions ADD COLUMN can_head BOOLEAN DEFAULT false;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'user_page_permissions' AND column_name = 'can_export') THEN
                    ALTER TABLE user_page_permissions ADD COLUMN can_export BOOLEAN DEFAULT false;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'user_page_permissions' AND column_name = 'label') THEN
                    ALTER TABLE user_page_permissions ADD COLUMN label VARCHAR(255) DEFAULT '';
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'user_page_permissions' AND column_name = 'username') THEN
                    ALTER TABLE user_page_permissions ADD COLUMN username VARCHAR(100) DEFAULT '';
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'user_page_permissions' AND column_name = 'can_organization') THEN
                    ALTER TABLE user_page_permissions ADD COLUMN can_organization BOOLEAN DEFAULT false;
                END IF;
            END $$;
        `);

        // Migration: add location_id / location_name if missing
        await pool.query(`
            DO $$
            BEGIN
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'user_page_permissions' AND column_name = 'location_id') THEN
                    ALTER TABLE user_page_permissions ADD COLUMN location_id INTEGER NOT NULL DEFAULT 0;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'user_page_permissions' AND column_name = 'location_name') THEN
                    ALTER TABLE user_page_permissions ADD COLUMN location_name VARCHAR(100) NOT NULL DEFAULT '';
                END IF;
            END $$;
        `);

        // Migration: replace legacy unique(user_id, page_id) with unique(user_id, location_id, page_id)
        await pool.query(`
            DO $$
            BEGIN
                IF EXISTS (
                    SELECT 1 FROM information_schema.table_constraints
                    WHERE table_name = 'user_page_permissions'
                      AND constraint_name = 'user_page_permissions_user_id_page_id_key'
                ) THEN
                    ALTER TABLE user_page_permissions DROP CONSTRAINT user_page_permissions_user_id_page_id_key;
                END IF;
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.table_constraints
                    WHERE table_name = 'user_page_permissions'
                      AND constraint_type = 'UNIQUE'
                      AND constraint_name = 'user_page_permissions_user_id_location_id_page_id_key'
                ) THEN
                    ALTER TABLE user_page_permissions
                    ADD CONSTRAINT user_page_permissions_user_id_location_id_page_id_key
                    UNIQUE (user_id, location_id, page_id);
                END IF;
            END $$;
        `);

        // Migration: user_id = personal_details.id
        await pool.query(`
            DO $$
            DECLARE
                r RECORD;
            BEGIN
                -- Remap legacy employment_details.id values to personal_details.id
                IF EXISTS (
                    SELECT 1 FROM information_schema.tables
                    WHERE table_name = 'employment_details'
                ) THEN
                    -- Merge permissions when target personal_details row already exists
                    UPDATE user_page_permissions target
                    SET
                        can_view = target.can_view OR legacy.can_view,
                        can_add = target.can_add OR legacy.can_add,
                        can_edit = target.can_edit OR legacy.can_edit,
                        can_delete = target.can_delete OR legacy.can_delete,
                        can_head = target.can_head OR legacy.can_head,
                        can_export = target.can_export OR legacy.can_export,
                        username = CASE
                            WHEN COALESCE(TRIM(target.username), '') = '' THEN legacy.username
                            ELSE target.username
                        END,
                        label = CASE
                            WHEN COALESCE(TRIM(target.label), '') = '' THEN legacy.label
                            ELSE target.label
                        END,
                        location_name = CASE
                            WHEN COALESCE(TRIM(target.location_name), '') = '' THEN legacy.location_name
                            ELSE target.location_name
                        END,
                        updated_at = CURRENT_TIMESTAMP
                    FROM user_page_permissions legacy
                    INNER JOIN employment_details ed ON legacy.user_id = ed.id
                    WHERE target.user_id = ed.personal_details_id
                      AND target.location_id = legacy.location_id
                      AND target.page_id = legacy.page_id
                      AND ed.personal_details_id IS NOT NULL
                      AND legacy.user_id <> ed.personal_details_id
                      AND target.id <> legacy.id;

                    -- Drop legacy rows that were merged into an existing personal_details row
                    DELETE FROM user_page_permissions legacy
                    USING employment_details ed
                    WHERE legacy.user_id = ed.id
                      AND ed.personal_details_id IS NOT NULL
                      AND legacy.user_id <> ed.personal_details_id
                      AND EXISTS (
                          SELECT 1
                          FROM user_page_permissions target
                          WHERE target.user_id = ed.personal_details_id
                            AND target.location_id = legacy.location_id
                            AND target.page_id = legacy.page_id
                      );

                    -- Remap remaining legacy rows (no unique-key conflict)
                    UPDATE user_page_permissions upp
                    SET user_id = ed.personal_details_id,
                        updated_at = CURRENT_TIMESTAMP
                    FROM employment_details ed
                    WHERE upp.user_id = ed.id
                      AND ed.personal_details_id IS NOT NULL
                      AND upp.user_id <> ed.personal_details_id;
                END IF;

                FOR r IN
                    SELECT con.conname
                    FROM pg_constraint con
                    JOIN pg_class rel ON rel.oid = con.conrelid
                    WHERE rel.relname = 'user_page_permissions'
                      AND con.contype = 'f'
                LOOP
                    EXECUTE format('ALTER TABLE user_page_permissions DROP CONSTRAINT %I', r.conname);
                END LOOP;

                IF EXISTS (
                    SELECT 1 FROM information_schema.tables
                    WHERE table_name = 'personal_details'
                ) AND NOT EXISTS (
                    SELECT 1 FROM pg_constraint con
                    JOIN pg_class rel ON rel.oid = con.conrelid
                    WHERE rel.relname = 'user_page_permissions'
                      AND con.conname = 'user_page_permissions_user_id_fkey'
                ) THEN
                    BEGIN
                        ALTER TABLE user_page_permissions
                        ADD CONSTRAINT user_page_permissions_user_id_fkey
                        FOREIGN KEY (user_id) REFERENCES personal_details(id) ON DELETE CASCADE;
                    EXCEPTION WHEN OTHERS THEN
                        RAISE NOTICE 'Skipped user_page_permissions_user_id_fkey: %', SQLERRM;
                    END;
                END IF;
            END $$;
        `);


        // Migration to add id as primary key to user_page_permissions if it's currently composite
        await pool.query(`
            DO $$ 
            BEGIN
                -- 1. Check if 'id' column exists
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'user_page_permissions' AND column_name = 'id') THEN
                    -- Add id column
                    ALTER TABLE user_page_permissions ADD COLUMN id SERIAL;
                    
                    -- 2. Drop the existing composite primary key if it exists
                    -- The default name is usually 'user_page_permissions_pkey'
                    IF EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE table_name = 'user_page_permissions' AND constraint_type = 'PRIMARY KEY') THEN
                        ALTER TABLE user_page_permissions DROP CONSTRAINT user_page_permissions_pkey;
                    END IF;
                    
                    -- 3. Set the new id column as primary key
                    ALTER TABLE user_page_permissions ADD PRIMARY KEY (id);
                END IF;
            END $$;
        `);

        // Ensure per-location page permissions: drop legacy unique(user_id, page_id) if present
        await pool.query(`
            DO $$
            BEGIN
                IF EXISTS (
                    SELECT 1 FROM information_schema.table_constraints
                    WHERE table_name = 'user_page_permissions'
                      AND constraint_name = 'user_page_permissions_user_id_page_id_key'
                ) THEN
                    ALTER TABLE user_page_permissions
                    DROP CONSTRAINT user_page_permissions_user_id_page_id_key;
                END IF;
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.table_constraints
                    WHERE table_name = 'user_page_permissions'
                      AND constraint_name = 'user_page_permissions_user_id_location_id_page_id_key'
                ) THEN
                    ALTER TABLE user_page_permissions
                    ADD CONSTRAINT user_page_permissions_user_id_location_id_page_id_key
                    UNIQUE (user_id, location_id, page_id);
                END IF;
            END $$;
        `);

        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_user_page_permissions_user_id ON user_page_permissions(user_id);
            CREATE INDEX IF NOT EXISTS idx_user_page_permissions_id ON user_page_permissions(id);
             CREATE INDEX IF NOT EXISTS idx_user_page_permissions_username_lower
                ON user_page_permissions (LOWER(TRIM(username)));
        `);
        // Create categories table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS categories (
                id SERIAL PRIMARY KEY,
                parent_id INTEGER REFERENCES categories(id) ON DELETE CASCADE,
                letter VARCHAR(1),
                name VARCHAR(255) NOT NULL,
                is_active BOOLEAN DEFAULT TRUE,
                default_users TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Existing DBs: add default_users if missing
        await pool.query(`
            ALTER TABLE categories
            ADD COLUMN IF NOT EXISTS default_users TEXT;
        `);

        // Existing DBs: add default_users if missing
        await pool.query(`
    ALTER TABLE categories
    ADD COLUMN IF NOT EXISTS default_users TEXT;
`);

        // Existing DBs: add category_type if missing (PROCESS vs CHECKLIST)
        await pool.query(`
    ALTER TABLE categories
    ADD COLUMN IF NOT EXISTS category_type VARCHAR(50)
    NOT NULL DEFAULT 'PROCESS';

    UPDATE categories
    SET category_type = 'PROCESS'
    WHERE category_type IS NULL
       OR TRIM(category_type) = '';

    ALTER TABLE categories
    DROP CONSTRAINT IF EXISTS categories_category_type_check;

    ALTER TABLE categories
    ADD CONSTRAINT categories_category_type_check
    CHECK (
        category_type IN (
            'PROCESS',
            'CHECKLIST'
        )
    );
`);

        // Create index for categories
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_categories_parent_id ON categories(parent_id);
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS category_type (
                id SERIAL PRIMARY KEY,
                module VARCHAR(255) NOT NULL,
                process BOOLEAN NOT NULL DEFAULT FALSE,
                checklist BOOLEAN NOT NULL DEFAULT FALSE,
                is_active BOOLEAN DEFAULT TRUE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                CONSTRAINT category_type_module_unique UNIQUE (module)
            );
        `);

        await pool.query(`
            ALTER TABLE category_type
            ADD COLUMN IF NOT EXISTS module VARCHAR(255);

            ALTER TABLE category_type
            ADD COLUMN IF NOT EXISTS process BOOLEAN NOT NULL DEFAULT FALSE;

            ALTER TABLE category_type
            ADD COLUMN IF NOT EXISTS checklist BOOLEAN NOT NULL DEFAULT FALSE;

            ALTER TABLE category_type
            ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;
        `);

        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_category_type_module ON category_type (LOWER(TRIM(module)));
        `);

        // Drop any unique constraints/indexes on category name (allow duplicate names)
        await pool.query(`
            DROP INDEX IF EXISTS idx_categories_parent_name_unique;
        `);
        await pool.query(`
            DO $$
            DECLARE r RECORD;
            BEGIN
                FOR r IN
                    SELECT c.conname
                    FROM pg_constraint c
                    JOIN pg_class t ON c.conrelid = t.oid
                    WHERE t.relname = 'categories'
                      AND c.contype = 'u'
                      AND pg_get_constraintdef(c.oid) ILIKE '%name%'
                LOOP
                    EXECUTE format('ALTER TABLE categories DROP CONSTRAINT IF EXISTS %I', r.conname);
                END LOOP;
            END $$;
        `);

        // Resync categories id sequence (imports/manual ids can leave SERIAL behind MAX(id))
        try {
            const catMaxResult = await pool.query(
                'SELECT COALESCE(MAX(id), 0) AS max_id FROM categories',
            );
            const catMaxId = Math.max(parseInt(catMaxResult.rows[0].max_id, 10) || 0, 1);
            const catSeqResult = await pool.query(
                `SELECT pg_get_serial_sequence('categories', 'id') AS sequence_name`,
            );
            const catSequenceName = catSeqResult.rows[0]?.sequence_name;
            if (catSequenceName) {
                await pool.query('SELECT setval($1, $2, true)', [
                    catSequenceName,
                    catMaxId,
                ]);
                console.log(`✅ categories id sequence synced to ${catMaxId}`);
            }
        } catch (seqErr) {
            console.warn('⚠ categories id sequence sync skipped:', seqErr.message);
        }

        // Create departments table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS departments (
                id SERIAL PRIMARY KEY,
                name VARCHAR(100) UNIQUE NOT NULL,
                description TEXT,
                is_active BOOLEAN DEFAULT TRUE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Create index for departments
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_departments_name ON departments(name);
        `);

        // Seed categories if empty


        // Create REQUIREMENT table in Database 2 (or Database 1 if DB not configured)
        await pool.query(`
      -- Create REQUIREMENT table with all columns
      CREATE TABLE IF NOT EXISTS "REQUIREMENT" (
          "sr.no" SERIAL PRIMARY KEY,
          date VARCHAR(10),
          serial_number VARCHAR(50),
          product_name VARCHAR(255) NOT NULL,
          quantity NUMERIC(10, 2) NOT NULL,
          unit VARCHAR(50),
          package VARCHAR(255),
          remark TEXT,
          product_photo TEXT,
          link TEXT,
          project_code VARCHAR(255),
          target_receive_date VARCHAR(10),
          require_person_name VARCHAR(255),
          order_person_name VARCHAR(255),
          review_person VARCHAR(255),
          order_status VARCHAR(50) DEFAULT 'Normal',
          receive_qty NUMERIC(10, 2),
          vendor VARCHAR(255),
          price_per_piece NUMERIC(10, 2),
          order_date VARCHAR(10),
          sku VARCHAR(100),
          expected_date VARCHAR(10),
          receive_date VARCHAR(10),
          receiver_name VARCHAR(255),
          mnp VARCHAR(255),
          requirement_type VARCHAR(100),
          status VARCHAR(50) ,
          order_qty NUMERIC(10, 2),
          pcb_code VARCHAR(255),
          lot_no VARCHAR(255),
          split VARCHAR(255),
          order_id VARCHAR(255),
          order_tracking_link TEXT,
          location VARCHAR(255),
          qtyreservation_status VARCHAR(50),
          qtyreservation_id INTEGER,
          fixed_quantity NUMERIC(10, 2),
          requirement_priority VARCHAR(50) DEFAULT 'Any',
          "bill_or_product_photo" TEXT,
          note TEXT,
          "addQuantityID" TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Add status column if not exists
      DO $$ 
      BEGIN
          IF NOT EXISTS (
              SELECT 1 FROM information_schema.columns 
              WHERE table_name = 'REQUIREMENT' AND column_name = 'status'
          ) THEN
              ALTER TABLE "REQUIREMENT" ADD COLUMN status VARCHAR(50) DEFAULT 'Request Review';
              UPDATE "REQUIREMENT" SET status = 'Request Review' WHERE status IS NULL;
          END IF;
      END $$;

      -- Add order_qty column if not exists
      DO $$ 
      BEGIN
          IF NOT EXISTS (
              SELECT 1 FROM information_schema.columns 
              WHERE table_name = 'REQUIREMENT' AND column_name = 'order_qty'
          ) THEN
              ALTER TABLE "REQUIREMENT" ADD COLUMN order_qty NUMERIC(10, 2);
          END IF;
      END $$;

      -- Add bill_or_product_photo column if not exists
      DO $$ 
      BEGIN
          IF NOT EXISTS (
              SELECT 1 FROM information_schema.columns 
              WHERE table_name = 'REQUIREMENT' AND column_name = 'bill_or_product_photo'
          ) THEN
              ALTER TABLE "REQUIREMENT" ADD COLUMN "bill_or_product_photo" TEXT;
          END IF;
      END $$;

      -- Add review_person (who performed / owns request review) if not exists
      DO $$ 
      BEGIN
          IF NOT EXISTS (
              SELECT 1 FROM information_schema.columns 
              WHERE table_name = 'REQUIREMENT' AND column_name = 'review_person'
          ) THEN
              ALTER TABLE "REQUIREMENT" ADD COLUMN review_person VARCHAR(255);
          END IF;
      END $$;

      -- Add pcb_code (PCB design reference) if not exists
      DO $$
      BEGIN
          IF NOT EXISTS (
              SELECT 1 FROM information_schema.columns
              WHERE table_name = 'REQUIREMENT' AND column_name = 'pcb_code'
          ) THEN
              ALTER TABLE "REQUIREMENT" ADD COLUMN pcb_code VARCHAR(255);
          END IF;
      END $$;

      -- Add lot_no (production lot reference) if not exists
      DO $$
      BEGIN
          IF NOT EXISTS (
              SELECT 1 FROM information_schema.columns
              WHERE table_name = 'REQUIREMENT' AND column_name = 'lot_no'
          ) THEN
              ALTER TABLE "REQUIREMENT" ADD COLUMN lot_no VARCHAR(255);
          END IF;
      END $$;

      -- Add split / order_id / order_tracking_link if not exists
      DO $$
      BEGIN
          IF NOT EXISTS (
              SELECT 1 FROM information_schema.columns
              WHERE table_name = 'REQUIREMENT' AND column_name = 'split'
          ) THEN
              ALTER TABLE "REQUIREMENT" ADD COLUMN split VARCHAR(255);
          END IF;
          IF NOT EXISTS (
              SELECT 1 FROM information_schema.columns
              WHERE table_name = 'REQUIREMENT' AND column_name = 'order_id'
          ) THEN
              ALTER TABLE "REQUIREMENT" ADD COLUMN order_id VARCHAR(255);
          END IF;
          IF NOT EXISTS (
              SELECT 1 FROM information_schema.columns
              WHERE table_name = 'REQUIREMENT' AND column_name = 'order_tracking_link'
          ) THEN
              ALTER TABLE "REQUIREMENT" ADD COLUMN order_tracking_link TEXT;
          END IF;
      END $$;

      -- Add location / qtyreservation_status if not exists
      DO $$
      BEGIN
          IF NOT EXISTS (
              SELECT 1 FROM information_schema.columns
              WHERE table_name = 'REQUIREMENT' AND column_name = 'location'
          ) THEN
              ALTER TABLE "REQUIREMENT" ADD COLUMN location VARCHAR(255);
          END IF;
          IF NOT EXISTS (
              SELECT 1 FROM information_schema.columns
              WHERE table_name = 'REQUIREMENT' AND column_name = 'qtyreservation_status'
          ) THEN
              ALTER TABLE "REQUIREMENT" ADD COLUMN qtyreservation_status VARCHAR(50);
          END IF;
          IF NOT EXISTS (
              SELECT 1 FROM information_schema.columns
              WHERE table_name = 'REQUIREMENT' AND column_name = 'qtyreservation_id'
          ) THEN
              ALTER TABLE "REQUIREMENT" ADD COLUMN qtyreservation_id INTEGER;
          END IF;
          IF NOT EXISTS (
              SELECT 1 FROM information_schema.columns
              WHERE table_name = 'REQUIREMENT' AND column_name = 'fixed_quantity'
          ) THEN
              ALTER TABLE "REQUIREMENT" ADD COLUMN fixed_quantity NUMERIC(10, 2);
          END IF;
          IF NOT EXISTS (
              SELECT 1 FROM information_schema.columns
              WHERE table_name = 'REQUIREMENT' AND column_name = 'note'
          ) THEN
              ALTER TABLE "REQUIREMENT" ADD COLUMN note TEXT;
          END IF;
          IF NOT EXISTS (
              SELECT 1 FROM information_schema.columns
              WHERE table_name = 'REQUIREMENT' AND column_name = 'requirement_priority'
          ) THEN
              ALTER TABLE "REQUIREMENT" ADD COLUMN requirement_priority VARCHAR(50) DEFAULT 'Any';
          END IF;
          IF NOT EXISTS (
              SELECT 1 FROM information_schema.columns
              WHERE table_name = 'REQUIREMENT' AND column_name = 'addQuantityID'
          ) THEN
              ALTER TABLE "REQUIREMENT" ADD COLUMN "addQuantityID" TEXT;
          END IF;
      END $$;

      -- Create indexes
      CREATE INDEX IF NOT EXISTS idx_requirement_product_name ON "REQUIREMENT"(product_name);
      CREATE INDEX IF NOT EXISTS idx_requirement_project_code ON "REQUIREMENT"(project_code);
      CREATE INDEX IF NOT EXISTS idx_requirement_order_status ON "REQUIREMENT"(order_status);
      CREATE INDEX IF NOT EXISTS idx_requirement_serial_number ON "REQUIREMENT"(serial_number);
      CREATE INDEX IF NOT EXISTS idx_requirement_date ON "REQUIREMENT"(date);
      CREATE INDEX IF NOT EXISTS idx_requirement_created_at ON "REQUIREMENT"(created_at);
      CREATE INDEX IF NOT EXISTS idx_requirement_status ON "REQUIREMENT"(status);
      CREATE INDEX IF NOT EXISTS idx_requirement_order_qty ON "REQUIREMENT"(order_qty);
      CREATE INDEX IF NOT EXISTS idx_requirement_pcb_code ON "REQUIREMENT"(pcb_code) WHERE pcb_code IS NOT NULL AND TRIM(pcb_code) <> '';
      CREATE INDEX IF NOT EXISTS idx_requirement_lot_no ON "REQUIREMENT"(lot_no) WHERE lot_no IS NOT NULL AND TRIM(lot_no) <> '';
      CREATE INDEX IF NOT EXISTS idx_requirement_location ON "REQUIREMENT"(location) WHERE location IS NOT NULL AND TRIM(location) <> '';
      CREATE INDEX IF NOT EXISTS idx_requirement_qtyreservation_status ON "REQUIREMENT"(qtyreservation_status);
      CREATE INDEX IF NOT EXISTS idx_requirement_qtyreservation_id ON "REQUIREMENT"(qtyreservation_id);
      -- Do NOT index bill_or_product_photo: values can be large (base64); B-tree index tuples are ~8KB max.

      -- Add unique constraint on serial_number if not exists
      DO $$
      BEGIN
          IF NOT EXISTS (
              SELECT 1 FROM information_schema.table_constraints 
              WHERE constraint_name = 'requirement_serial_number_unique'
          ) THEN
              ALTER TABLE "REQUIREMENT"
              ADD CONSTRAINT requirement_serial_number_unique UNIQUE (serial_number);
          END IF;
      END $$;

      
      -- Add comments
      COMMENT ON TABLE "REQUIREMENT" IS 'Requirement table storing product requirements and order information';
      COMMENT ON COLUMN "REQUIREMENT".date IS 'Requirement date in dd-mm-yyyy format';
      COMMENT ON COLUMN "REQUIREMENT".serial_number IS 'Serial number in format RFQ-YYMM-XXX. UNIQUE constraint ensures global uniqueness across ALL users - no duplicate serial numbers system-wide, even if requirements are terminated';
      COMMENT ON COLUMN "REQUIREMENT".status IS 'Status of the requirement (Request Review, Review Done, In Store, etc.)';
      COMMENT ON COLUMN "REQUIREMENT".order_qty IS 'Order quantity - quantity ordered';
      COMMENT ON COLUMN "REQUIREMENT".product_photo IS 'Product image URL (Cloudinary or external https URL)';
      COMMENT ON COLUMN "REQUIREMENT"."bill_or_product_photo" IS 'Bill image URL (Cloudinary or external https URL)';

      DROP TABLE IF EXISTS r2r_requirement_files;
      COMMENT ON COLUMN "REQUIREMENT".pcb_code IS 'Optional PCB design code linking requirement to PCB module';
      COMMENT ON COLUMN "REQUIREMENT".lot_no IS 'Optional production lot number linking requirement to manufacturing batch';
      COMMENT ON COLUMN "REQUIREMENT".split IS 'Split order reference / flag';
      COMMENT ON COLUMN "REQUIREMENT".order_id IS 'External purchase order / marketplace order id';
      COMMENT ON COLUMN "REQUIREMENT".order_tracking_link IS 'URL for order shipment tracking';
      COMMENT ON COLUMN "REQUIREMENT".location IS 'Store / warehouse location for the requirement';
      COMMENT ON COLUMN "REQUIREMENT".qtyreservation_status IS 'Quantity reservation workflow status';
      COMMENT ON COLUMN "REQUIREMENT".qtyreservation_id IS 'Linked QTY_RESERVATION.id for this requirement';
      COMMENT ON COLUMN "REQUIREMENT".fixed_quantity IS 'Quantity locked on add/edit; not changed by split/receive updates';
      COMMENT ON COLUMN "REQUIREMENT"."addQuantityID" IS 'Store add-quantity history id from POST /store/add-quantity';

      -- Create trigger to update updated_at timestamp
      CREATE OR REPLACE FUNCTION update_requirement_updated_at()
      RETURNS TRIGGER AS $$
      BEGIN
          NEW.updated_at = CURRENT_TIMESTAMP;
          RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS trigger_update_requirement_updated_at ON "REQUIREMENT";
      CREATE TRIGGER trigger_update_requirement_updated_at
          BEFORE UPDATE ON "REQUIREMENT"
          FOR EACH ROW
          EXECUTE FUNCTION update_requirement_updated_at();

      -- Keep pg_notify payload under 8000 bytes (PG < 18) when REQUIREMENT notify trigger exists
      CREATE OR REPLACE FUNCTION notify_requirement_changes()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $$
      DECLARE
        change_data jsonb;
        payload text;
        rowj jsonb;
        max_bytes constant int := 7900;
        notified_channel text := 'requirement_changes_db1';
      BEGIN
        IF TG_OP = 'DELETE' THEN
          rowj := to_jsonb(OLD);
        ELSE
          rowj := to_jsonb(NEW);
        END IF;
        change_data := jsonb_build_object(
          'operation', TG_OP,
          'table', TG_TABLE_NAME,
          'record', rowj
        );
        payload := change_data::text;
        IF octet_length(payload) > max_bytes THEN
          rowj := rowj - 'product_photo' - 'remark' - 'link' - 'bill_or_product_photo';
          change_data := jsonb_build_object(
            'operation', TG_OP,
            'table', TG_TABLE_NAME,
            'record', rowj,
            'payload_stripped', true
          );
          payload := change_data::text;
        END IF;
        IF octet_length(payload) > max_bytes THEN
          IF TG_OP = 'DELETE' THEN
            change_data := jsonb_build_object(
              'operation', TG_OP,
              'table', TG_TABLE_NAME,
              'record', jsonb_build_object(
                'sr.no', OLD."sr.no",
                'serial_number', OLD.serial_number
              ),
              'payload_stripped', true,
              'payload_minimal', true
            );
          ELSE
            change_data := jsonb_build_object(
              'operation', TG_OP,
              'table', TG_TABLE_NAME,
              'record', jsonb_build_object(
                'sr.no', NEW."sr.no",
                'serial_number', NEW.serial_number
              ),
              'payload_stripped', true,
              'payload_minimal', true
            );
          END IF;
          payload := change_data::text;
        END IF;
        PERFORM pg_notify(notified_channel, payload);
        IF TG_OP = 'DELETE' THEN
          RETURN OLD;
        END IF;
        RETURN NEW;
      END;
      $$;
    `);
        console.log('✅ REQUIREMENT table created/verified in Database 1');


        await pool.query(`CREATE TABLE IF NOT EXISTS "TEMP_REQUIREMENT" (
    id SERIAL PRIMARY KEY,

    temp_id UUID DEFAULT gen_random_uuid(),

    user_id INTEGER,
    username TEXT,
    socket_id TEXT,

    date DATE,
    product_name TEXT,
    quantity NUMERIC(10, 2),
    unit TEXT,
    package TEXT,
    remark TEXT,

    product_photo TEXT,
    bom_file TEXT,
    bom_preview JSONB,

    data JSONB,

    link TEXT,
    project_code TEXT,
    target_receive_date DATE,

    require_person_name TEXT,
    order_person_name TEXT,
    review_person TEXT,

    order_status TEXT,
    receive_qty NUMERIC(10, 2),

    vendor TEXT,
    price_per_piece NUMERIC,

    order_date DATE,
    sku TEXT,
    expected_date DATE,
    receive_date DATE,

    receiver_name TEXT,
    mnp TEXT,
    requirement_type TEXT,  
    serial_number TEXT,
    status TEXT,
    order_qty NUMERIC(10, 2),
    pcb_code TEXT,
    lot_no TEXT,
    split TEXT,
    order_id TEXT,
    order_tracking_link TEXT,

    is_completed BOOLEAN DEFAULT false,

    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);`);

        console.log('✅ TEMP_REQUIREMENT table created/verified in Database 1');

        await pool.query(`ALTER TABLE "TEMP_REQUIREMENT" ADD COLUMN IF NOT EXISTS data JSONB`);
        await pool.query(`ALTER TABLE "TEMP_REQUIREMENT" ADD COLUMN IF NOT EXISTS split TEXT`);
        await pool.query(`ALTER TABLE "TEMP_REQUIREMENT" ADD COLUMN IF NOT EXISTS order_id TEXT`);
        await pool.query(`ALTER TABLE "TEMP_REQUIREMENT" ADD COLUMN IF NOT EXISTS order_tracking_link TEXT`);
        await pool.query(`ALTER TABLE "TEMP_REQUIREMENT" ADD COLUMN IF NOT EXISTS username TEXT`);
        // Allow decimal qty values (e.g. 5.5) — older DBs used INTEGER
        await pool.query(`
            DO $$
            BEGIN
                IF EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public'
                      AND table_name = 'TEMP_REQUIREMENT'
                      AND column_name = 'quantity'
                      AND data_type = 'integer'
                ) THEN
                    ALTER TABLE "TEMP_REQUIREMENT"
                    ALTER COLUMN quantity TYPE NUMERIC(10, 2)
                    USING quantity::numeric;
                END IF;
                IF EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public'
                      AND table_name = 'TEMP_REQUIREMENT'
                      AND column_name = 'receive_qty'
                      AND data_type = 'integer'
                ) THEN
                    ALTER TABLE "TEMP_REQUIREMENT"
                    ALTER COLUMN receive_qty TYPE NUMERIC(10, 2)
                    USING receive_qty::numeric;
                END IF;
                IF EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public'
                      AND table_name = 'TEMP_REQUIREMENT'
                      AND column_name = 'order_qty'
                      AND data_type = 'integer'
                ) THEN
                    ALTER TABLE "TEMP_REQUIREMENT"
                    ALTER COLUMN order_qty TYPE NUMERIC(10, 2)
                    USING order_qty::numeric;
                END IF;
            END $$;
        `);
        await pool.query(`
            DO $$
            BEGIN
                IF EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public'
                      AND table_name = 'REQUIREMENT'
                      AND column_name = 'quantity'
                      AND data_type = 'integer'
                ) THEN
                    ALTER TABLE "REQUIREMENT"
                    ALTER COLUMN quantity TYPE NUMERIC(10, 2)
                    USING quantity::numeric;
                END IF;
                IF EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public'
                      AND table_name = 'REQUIREMENT'
                      AND column_name = 'receive_qty'
                      AND data_type = 'integer'
                ) THEN
                    ALTER TABLE "REQUIREMENT"
                    ALTER COLUMN receive_qty TYPE NUMERIC(10, 2)
                    USING receive_qty::numeric;
                END IF;
                IF EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public'
                      AND table_name = 'REQUIREMENT'
                      AND column_name = 'order_qty'
                      AND data_type = 'integer'
                ) THEN
                    ALTER TABLE "REQUIREMENT"
                    ALTER COLUMN order_qty TYPE NUMERIC(10, 2)
                    USING order_qty::numeric;
                END IF;
            END $$;
        `);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_temp_requirement_temp_id ON "TEMP_REQUIREMENT" (temp_id)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_temp_requirement_username ON "TEMP_REQUIREMENT" (LOWER(TRIM(username)))`);





        // Requirement status transition history
        await pool.query(`
      CREATE TABLE IF NOT EXISTS "REQUIREMENT_STATUS" (
          id SERIAL PRIMARY KEY,
          serial_number VARCHAR(50),
          date DATE NOT NULL DEFAULT CURRENT_DATE,
          old_status VARCHAR(100),
          new_status VARCHAR(100),
          time TIME NOT NULL DEFAULT CURRENT_TIME,
          duration INTERVAL,
          username VARCHAR(255),
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      ALTER TABLE "REQUIREMENT_STATUS"
      ADD COLUMN IF NOT EXISTS username VARCHAR(255);

      CREATE INDEX IF NOT EXISTS idx_requirement_status_serial_number
          ON "REQUIREMENT_STATUS"(serial_number);
      CREATE INDEX IF NOT EXISTS idx_requirement_status_date
          ON "REQUIREMENT_STATUS"(date);
      CREATE INDEX IF NOT EXISTS idx_requirement_status_created_at
          ON "REQUIREMENT_STATUS"(created_at);
      CREATE INDEX IF NOT EXISTS idx_requirement_status_new_status
          ON "REQUIREMENT_STATUS"(new_status);
      CREATE INDEX IF NOT EXISTS idx_requirement_status_username
          ON "REQUIREMENT_STATUS"(LOWER(TRIM(username)));

      COMMENT ON TABLE "REQUIREMENT_STATUS" IS 'Tracks requirement status transitions with timing';
      COMMENT ON COLUMN "REQUIREMENT_STATUS".serial_number IS 'Requirement serial number (e.g. RFQ-YYMM-XXX)';
      COMMENT ON COLUMN "REQUIREMENT_STATUS".date IS 'Date of status change';
      COMMENT ON COLUMN "REQUIREMENT_STATUS".old_status IS 'Previous requirement status';
      COMMENT ON COLUMN "REQUIREMENT_STATUS".new_status IS 'New requirement status after change';
      COMMENT ON COLUMN "REQUIREMENT_STATUS".time IS 'Time of status change';
      COMMENT ON COLUMN "REQUIREMENT_STATUS".duration IS 'Time spent in old_status before this change';
      COMMENT ON COLUMN "REQUIREMENT_STATUS".username IS 'User who triggered the status change';
        `);
        console.log('✅ REQUIREMENT_STATUS table created/verified in Database 1');

        // Temp BOM image staging for RFQ create/transfer
        await pool.query(`
      CREATE TABLE IF NOT EXISTS r2r_temp_bom_images (
          id SERIAL PRIMARY KEY,
          serial_number VARCHAR(100),
          sku VARCHAR(255),
          original_image TEXT,
          processed_image_url TEXT,
          upload_status VARCHAR(50) DEFAULT 'PENDING',
          processing_status VARCHAR(50) DEFAULT 'WAITING',
          kind VARCHAR(50) DEFAULT 'product',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_r2r_temp_bom_images_serial
          ON r2r_temp_bom_images(serial_number);
      CREATE INDEX IF NOT EXISTS idx_r2r_temp_bom_images_updated_at
          ON r2r_temp_bom_images(updated_at DESC);
        `);
        console.log('✅ r2r_temp_bom_images table created/verified in Database 1');

        // Create ISSUE table
        await pool.query(`
      -- Create ISSUE table for tracking issues reported from different pages
      CREATE TABLE IF NOT EXISTS "ISSUE" (
          "sr.no" SERIAL PRIMARY KEY,
          "serial_number" VARCHAR(50),
          "requirement_id" INTEGER,
          "sender_username" VARCHAR(255) NOT NULL,
          "page_name" VARCHAR(255) NOT NULL,
          "notes" TEXT NOT NULL,
          "receive_username" VARCHAR(255) NOT NULL,
          "order_status" VARCHAR(50),
          "issue_order_status" VARCHAR(50),
          "date" DATE NOT NULL DEFAULT CURRENT_DATE,
          "time" TIME NOT NULL DEFAULT CURRENT_TIME,
          "created_at" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          "updated_at" TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Create foreign key constraint to REQUIREMENT table
      DO $$
      BEGIN
          IF NOT EXISTS (
              SELECT 1 FROM information_schema.table_constraints 
              WHERE constraint_name = 'fk_issue_requirement'
          ) THEN
              ALTER TABLE "ISSUE"
              ADD CONSTRAINT fk_issue_requirement
              FOREIGN KEY ("requirement_id")
              REFERENCES "REQUIREMENT"("sr.no")
              ON DELETE CASCADE;
          END IF;
      END $$;

      -- Add order_status column if not exists
      DO $$ 
      BEGIN
          IF NOT EXISTS (
              SELECT 1 FROM information_schema.columns 
              WHERE table_name = 'ISSUE' AND column_name = 'order_status'
          ) THEN
              ALTER TABLE "ISSUE" ADD COLUMN "order_status" VARCHAR(50);
          END IF;
      END $$;

      -- Add issue_order_status column if not exists
      DO $$ 
      BEGIN
          IF NOT EXISTS (
              SELECT 1 FROM information_schema.columns 
              WHERE table_name = 'ISSUE' AND column_name = 'issue_order_status'
          ) THEN
              ALTER TABLE "ISSUE" ADD COLUMN "issue_order_status" VARCHAR(50);
          END IF;
      END $$;

      -- Create indexes
      CREATE INDEX IF NOT EXISTS idx_issue_requirement_id ON "ISSUE"("requirement_id");
      CREATE INDEX IF NOT EXISTS idx_issue_serial_number ON "ISSUE"("serial_number");
      CREATE INDEX IF NOT EXISTS idx_issue_receive_username ON "ISSUE"("receive_username");
      CREATE INDEX IF NOT EXISTS idx_issue_order_status ON "ISSUE"("order_status");
      CREATE INDEX IF NOT EXISTS idx_issue_issue_order_status ON "ISSUE"("issue_order_status");
      CREATE INDEX IF NOT EXISTS idx_issue_date ON "ISSUE"("date");
      CREATE INDEX IF NOT EXISTS idx_issue_created_at ON "ISSUE"("created_at");

      -- Add comments
      COMMENT ON TABLE "ISSUE" IS 'Table for storing issue notifications sent to heads of require_person';
      COMMENT ON COLUMN "ISSUE"."sr.no" IS 'Primary key - Serial number';
      COMMENT ON COLUMN "ISSUE"."serial_number" IS 'Serial number from REQUIREMENT table (for easy reference)';
      COMMENT ON COLUMN "ISSUE"."requirement_id" IS 'Foreign key reference to REQUIREMENT table';
      COMMENT ON COLUMN "ISSUE"."sender_username" IS 'Username of the person who reported the issue';
      COMMENT ON COLUMN "ISSUE"."page_name" IS 'Page name where the issue was reported (e.g., "In Store check", "Request Review", "Terminate")';
      COMMENT ON COLUMN "ISSUE"."notes" IS 'Issue description/notes';
      COMMENT ON COLUMN "ISSUE"."receive_username" IS 'Username of the person who should receive the notification';
      COMMENT ON COLUMN "ISSUE"."order_status" IS 'Order status at the time the issue was reported (e.g., "Normal", "Urgent", "Issue")';
      COMMENT ON COLUMN "ISSUE"."issue_order_status" IS 'Original order status of the requirement before the issue was created - restored when issue is fixed';
      COMMENT ON COLUMN "ISSUE"."date" IS 'Date when the issue was reported';
      COMMENT ON COLUMN "ISSUE"."time" IS 'Time when the issue was reported';
      COMMENT ON COLUMN "ISSUE"."created_at" IS 'Timestamp when the record was created';
      COMMENT ON COLUMN "ISSUE"."updated_at" IS 'Timestamp when the record was last updated';
    `);
        console.log('✅ ISSUE table created/verified');

        // Purchase / In Store "team" issues use NULL receive_username so every user with
        // request-review permission sees the row in GET /api/issues (see issue.controller).
        await pool.query(`
            DO $$
            BEGIN
                IF EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'ISSUE'
                      AND column_name = 'receive_username' AND is_nullable = 'NO'
                ) THEN
                    ALTER TABLE "ISSUE" ALTER COLUMN "receive_username" DROP NOT NULL;
                END IF;
            END $$;
        `);

        // Qty reservation (store / project allocation)
        await pool.query(`
      CREATE TABLE IF NOT EXISTS "QTY_RESERVATION" (
          id SERIAL PRIMARY KEY,
          requirement_id TEXT,
          serial_number TEXT,
          sku VARCHAR(100),
          item_name VARCHAR(255),
          location VARCHAR(255),
          target_receive_date TEXT,
          req_qty TEXT,
          receive_qty NUMERIC(10, 2),
          reserved_qty NUMERIC(10, 2),
          remove_quantity NUMERIC(10, 2),
          "remove_qtyID" TEXT,
          fixed_quantity NUMERIC(10, 2),
          req_username VARCHAR(255),
          receive_username VARCHAR(255),
          reserved_username VARCHAR(255),
          remove_username VARCHAR(255),
          remove_date TIMESTAMP,
          review TEXT,
          review_username VARCHAR(255),
          review_date TIMESTAMP,
          project_code VARCHAR(255),
          pcb_code VARCHAR(255),
          lot_no VARCHAR(255),
          comment TEXT,
          qtyreservation_status VARCHAR(50),
          is_read BOOLEAN,
          items_image TEXT,
          created_by VARCHAR(255),
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_qty_reservation_requirement_id
          ON "QTY_RESERVATION"(requirement_id);
      CREATE INDEX IF NOT EXISTS idx_qty_reservation_serial_number
          ON "QTY_RESERVATION"(serial_number);
      CREATE INDEX IF NOT EXISTS idx_qty_reservation_sku
          ON "QTY_RESERVATION"(sku);
      CREATE INDEX IF NOT EXISTS idx_qty_reservation_status
          ON "QTY_RESERVATION"(qtyreservation_status);
      CREATE INDEX IF NOT EXISTS idx_qty_reservation_project_code
          ON "QTY_RESERVATION"(project_code);
      CREATE INDEX IF NOT EXISTS idx_qty_reservation_created_at
          ON "QTY_RESERVATION"(created_at);

      COMMENT ON TABLE "QTY_RESERVATION" IS 'Quantity reservation against requirements / store stock';
        `);

        // Migrate older QTY_RESERVATION column names if present
        await pool.query(`
      DO $$
      BEGIN
          IF EXISTS (
              SELECT 1 FROM information_schema.columns
              WHERE table_name = 'QTY_RESERVATION' AND column_name = 'pcb'
          ) AND NOT EXISTS (
              SELECT 1 FROM information_schema.columns
              WHERE table_name = 'QTY_RESERVATION' AND column_name = 'pcb_code'
          ) THEN
              ALTER TABLE "QTY_RESERVATION" RENAME COLUMN pcb TO pcb_code;
          END IF;

          IF NOT EXISTS (
              SELECT 1 FROM information_schema.columns
              WHERE table_name = 'QTY_RESERVATION' AND column_name = 'pcb_code'
          ) THEN
              ALTER TABLE "QTY_RESERVATION" ADD COLUMN pcb_code VARCHAR(255);
          END IF;

          IF EXISTS (
              SELECT 1 FROM information_schema.columns
              WHERE table_name = 'QTY_RESERVATION' AND column_name = 'status'
          ) AND NOT EXISTS (
              SELECT 1 FROM information_schema.columns
              WHERE table_name = 'QTY_RESERVATION' AND column_name = 'qtyreservation_status'
          ) THEN
              ALTER TABLE "QTY_RESERVATION" RENAME COLUMN status TO qtyreservation_status;
          END IF;

          IF NOT EXISTS (
              SELECT 1 FROM information_schema.columns
              WHERE table_name = 'QTY_RESERVATION' AND column_name = 'qtyreservation_status'
          ) THEN
              ALTER TABLE "QTY_RESERVATION" ADD COLUMN qtyreservation_status VARCHAR(50);
          END IF;

          IF NOT EXISTS (
              SELECT 1 FROM information_schema.columns
              WHERE table_name = 'QTY_RESERVATION' AND column_name = 'fixed_quantity'
          ) THEN
              ALTER TABLE "QTY_RESERVATION" ADD COLUMN fixed_quantity NUMERIC(10, 2);
          END IF;

          -- Allow comma-separated values across split RFQs
          IF EXISTS (
              SELECT 1 FROM information_schema.columns
              WHERE table_name = 'QTY_RESERVATION' AND column_name = 'serial_number'
                AND data_type <> 'text'
          ) THEN
              ALTER TABLE "QTY_RESERVATION" ALTER COLUMN serial_number TYPE TEXT;
          END IF;
          IF EXISTS (
              SELECT 1 FROM information_schema.columns
              WHERE table_name = 'QTY_RESERVATION' AND column_name = 'target_receive_date'
                AND data_type <> 'text'
          ) THEN
              ALTER TABLE "QTY_RESERVATION" ALTER COLUMN target_receive_date TYPE TEXT;
          END IF;
          IF EXISTS (
              SELECT 1 FROM information_schema.columns
              WHERE table_name = 'QTY_RESERVATION' AND column_name = 'req_qty'
                AND udt_name <> 'text'
          ) THEN
              ALTER TABLE "QTY_RESERVATION" ALTER COLUMN req_qty TYPE TEXT USING req_qty::text;
          END IF;

          -- Drop FK so requirement_id can hold comma-separated split RFQ ids
          IF EXISTS (
              SELECT 1 FROM information_schema.table_constraints
              WHERE constraint_name = 'fk_qty_reservation_requirement'
                AND table_name = 'QTY_RESERVATION'
          ) THEN
              ALTER TABLE "QTY_RESERVATION"
              DROP CONSTRAINT fk_qty_reservation_requirement;
          END IF;

          -- Allow comma-separated requirement ids across split RFQs (2+)
          IF EXISTS (
              SELECT 1 FROM information_schema.columns
              WHERE table_name = 'QTY_RESERVATION' AND column_name = 'requirement_id'
                AND data_type <> 'text'
                AND udt_name <> 'text'
          ) THEN
              ALTER TABLE "QTY_RESERVATION"
              ALTER COLUMN requirement_id TYPE TEXT USING requirement_id::text;
          END IF;

          -- Remove unused store_qty column
          IF EXISTS (
              SELECT 1 FROM information_schema.columns
              WHERE table_name = 'QTY_RESERVATION'
                AND column_name = 'store_qty'
          ) THEN
              ALTER TABLE "QTY_RESERVATION" DROP COLUMN store_qty;
          END IF;

          IF NOT EXISTS (
              SELECT 1 FROM information_schema.columns
              WHERE table_name = 'QTY_RESERVATION'
                AND column_name = 'items_image'
          ) THEN
              IF EXISTS (
                  SELECT 1 FROM information_schema.columns
                  WHERE table_name = 'QTY_RESERVATION'
                    AND column_name = 'items_photo'
              ) THEN
                  ALTER TABLE "QTY_RESERVATION" RENAME COLUMN items_photo TO items_image;
              ELSE
                  ALTER TABLE "QTY_RESERVATION" ADD COLUMN items_image TEXT;
              END IF;
          ELSIF EXISTS (
              SELECT 1 FROM information_schema.columns
              WHERE table_name = 'QTY_RESERVATION'
                AND column_name = 'items_photo'
          ) THEN
              -- Copy any legacy photo URLs then drop old column
              UPDATE "QTY_RESERVATION"
              SET items_image = items_photo
              WHERE (items_image IS NULL OR TRIM(items_image) = '')
                AND items_photo IS NOT NULL
                AND TRIM(items_photo) <> '';
              ALTER TABLE "QTY_RESERVATION" DROP COLUMN items_photo;
          END IF;

          IF NOT EXISTS (
              SELECT 1 FROM information_schema.columns
              WHERE table_name = 'QTY_RESERVATION'
                AND column_name = 'remove_quantity'
          ) THEN
              ALTER TABLE "QTY_RESERVATION"
              ADD COLUMN remove_quantity NUMERIC(10, 2);
          END IF;

          IF NOT EXISTS (
              SELECT 1 FROM information_schema.columns
              WHERE table_name = 'QTY_RESERVATION'
                AND column_name = 'remove_qtyID'
          ) THEN
              ALTER TABLE "QTY_RESERVATION"
              ADD COLUMN "remove_qtyID" TEXT;
          END IF;

          IF NOT EXISTS (
              SELECT 1 FROM information_schema.columns
              WHERE table_name = 'QTY_RESERVATION'
                AND column_name = 'remove_username'
          ) THEN
              ALTER TABLE "QTY_RESERVATION"
              ADD COLUMN remove_username VARCHAR(255);
          END IF;

          IF NOT EXISTS (
              SELECT 1 FROM information_schema.columns
              WHERE table_name = 'QTY_RESERVATION'
                AND column_name = 'remove_date'
          ) THEN
              ALTER TABLE "QTY_RESERVATION"
              ADD COLUMN remove_date TIMESTAMP;
          END IF;

          IF NOT EXISTS (
              SELECT 1 FROM information_schema.columns
              WHERE table_name = 'QTY_RESERVATION'
                AND column_name = 'review'
          ) THEN
              ALTER TABLE "QTY_RESERVATION"
              ADD COLUMN review TEXT;
          END IF;

          IF NOT EXISTS (
              SELECT 1 FROM information_schema.columns
              WHERE table_name = 'QTY_RESERVATION'
                AND column_name = 'review_username'
          ) THEN
              ALTER TABLE "QTY_RESERVATION"
              ADD COLUMN review_username VARCHAR(255);
          END IF;

          IF NOT EXISTS (
              SELECT 1 FROM information_schema.columns
              WHERE table_name = 'QTY_RESERVATION'
                AND column_name = 'review_date'
          ) THEN
              ALTER TABLE "QTY_RESERVATION"
              ADD COLUMN review_date TIMESTAMP;
          END IF;

          IF NOT EXISTS (
              SELECT 1 FROM information_schema.columns
              WHERE table_name = 'QTY_RESERVATION'
                AND column_name = 'receive_username'
          ) THEN
              ALTER TABLE "QTY_RESERVATION"
              ADD COLUMN receive_username VARCHAR(255);
          END IF;

          UPDATE "QTY_RESERVATION" qr
          SET receive_username = r.receiver_name
          FROM "REQUIREMENT" r
          WHERE (qr.receive_username IS NULL OR TRIM(qr.receive_username) = '')
            AND qr.requirement_id IS NOT NULL
            AND TRIM(qr.requirement_id) <> ''
            AND qr.requirement_id NOT LIKE '%,%'
            AND qr.requirement_id = r."sr.no"::text
            AND r.receiver_name IS NOT NULL
            AND TRIM(r.receiver_name) <> '';

          IF NOT EXISTS (
              SELECT 1 FROM information_schema.columns
              WHERE table_name = 'QTY_RESERVATION'
                AND column_name = 'is_read'
          ) THEN
              ALTER TABLE "QTY_RESERVATION"
              ADD COLUMN is_read BOOLEAN;
          END IF;
      END $$;
        `);
        console.log('✅ QTY_RESERVATION table created/verified');

        // READ_NOTIFICATION — flexible read-only notification table.
        // Covers any informational notification type (accept/decline, alerts, etc.)
        // that is for viewing only and should NOT be stored in the ISSUE table.
        // notification_type  : e.g. 'receive-issue-responded', 'qty-alert', …
        // page_name          : destination page label (e.g. 'Receive Items')
        // href               : optional direct link for navigation
        // meta               : JSON blob for extra type-specific fields
        // is_read            : toggled when user views / dismisses
        await pool.query(`
            CREATE TABLE IF NOT EXISTS "READ_NOTIFICATION" (
                id                 SERIAL PRIMARY KEY,
                notification_type  VARCHAR(100) NOT NULL,
                requirement_id     INTEGER,
                serial_number      VARCHAR(100),
                sender_username    VARCHAR(255) NOT NULL,
                receive_username   VARCHAR(255) NOT NULL,
                page_name          VARCHAR(255),
                href               TEXT,
                title              TEXT,
                message            TEXT,
                meta               JSONB,
                is_read            BOOLEAN NOT NULL DEFAULT FALSE,
                created_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE INDEX IF NOT EXISTS idx_rn_receive_username
                ON "READ_NOTIFICATION"(receive_username);
            CREATE INDEX IF NOT EXISTS idx_rn_requirement_id
                ON "READ_NOTIFICATION"(requirement_id);
            CREATE INDEX IF NOT EXISTS idx_rn_notification_type
                ON "READ_NOTIFICATION"(notification_type);
            CREATE INDEX IF NOT EXISTS idx_rn_is_read
                ON "READ_NOTIFICATION"(is_read);
            CREATE INDEX IF NOT EXISTS idx_rn_created_at
                ON "READ_NOTIFICATION"(created_at DESC);
        `);
        console.log('✅ READ_NOTIFICATION table created/verified');

        // Create UNITS table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS "UNITS" (
                id SERIAL PRIMARY KEY,
                unitname VARCHAR(100) NOT NULL UNIQUE,
                is_active BOOLEAN DEFAULT TRUE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log('✅ UNITS table created/verified');

        // Seed initial units if empty
        const unitsCount = await pool.query('SELECT COUNT(*) FROM "UNITS"');
        if (parseInt(unitsCount.rows[0].count) === 0) {
            console.log('Seeding initial units...');
            const initialUnits = [
                'PCS', 'KG', 'BOX', 'SET'
            ];
            for (const unit of initialUnits) {
                await pool.query('INSERT INTO "UNITS" (unitname) VALUES ($1)', [unit]);
            }
            console.log('Units seeded successfully');
        }

        // Create settings table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS settings (
                id SERIAL PRIMARY KEY,
                key VARCHAR(100) UNIQUE NOT NULL,
                value TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log('✅ settings table created/verified');

        // Create AUDIT_LOG table (update/delete history)
        await pool.query(`
            CREATE TABLE IF NOT EXISTS audit_log (
                id SERIAL PRIMARY KEY,
                action VARCHAR(10) NOT NULL, -- 'UPDATE' | 'DELETE'
                table_name VARCHAR(255) NOT NULL,
                table_of_id INTEGER,
                table_of_column TEXT,
                old_value JSONB,
                new_value JSONB,
                user_id INTEGER,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            DO $$
            BEGIN
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'audit_log' AND column_name = 'table_of_column') THEN
                    ALTER TABLE audit_log ADD COLUMN table_of_column TEXT;
                END IF;
            END $$;
            CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_audit_log_table_name ON audit_log(table_name);
            CREATE INDEX IF NOT EXISTS idx_audit_log_table_of_id ON audit_log(table_of_id);
            CREATE INDEX IF NOT EXISTS idx_audit_log_user_id ON audit_log(user_id);
        `);
        console.log('✅ audit_log table created/verified');

        // Seed initial settings if empty
        const settingsCount = await pool.query('SELECT COUNT(*) FROM settings');
        if (parseInt(settingsCount.rows[0].count) === 0) {
            console.log('Seeding initial settings...');
            await pool.query("INSERT INTO settings (key, value) VALUES ('serial_prefix', 'RFQ'), ('serial_year_format', 'FINANCIAL_YEAR')");
            console.log('Settings seeded successfully');
        }

        // Create CLIENT table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS "CLIENT" (
                id SERIAL PRIMARY KEY,
                company_name VARCHAR(255) NOT NULL,
                client_firstname VARCHAR(100),
                client_middlename VARCHAR(100),
                client_lastname VARCHAR(100),
                client_code VARCHAR(50) UNIQUE,
                client_mobile_no VARCHAR(20),
                contact_number VARCHAR(20),
                email_id VARCHAR(255),
                gst_code VARCHAR(50),
                location VARCHAR(255),
                bill_location VARCHAR(255),
                sheet_map_location VARCHAR(255),
                client_logo TEXT,
                sec_name VARCHAR(255),
                sec_mobile VARCHAR(20),
                sec_email VARCHAR(255),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                created_by VARCHAR(255),
                is_active BOOLEAN DEFAULT TRUE

            );
        `);
        console.log('✅ CLIENT table created/verified');
        await pool.query(`ALTER TABLE "CLIENT" ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;`);
        // Add indexes for CLIENT table
        await pool.query(`

            CREATE INDEX IF NOT EXISTS idx_client_company_name ON "CLIENT"(company_name);
            CREATE INDEX IF NOT EXISTS idx_client_code ON "CLIENT"(client_code);
            CREATE INDEX IF NOT EXISTS idx_client_email ON "CLIENT"(email_id);
            CREATE INDEX IF NOT EXISTS idx_client_created_at ON "CLIENT"(created_at);
        `);

        // Create trigger to update updated_at timestamp for CLIENT table
        await pool.query(`
            CREATE OR REPLACE FUNCTION update_client_updated_at()
            RETURNS TRIGGER AS $$
            BEGIN
                NEW.updated_at = CURRENT_TIMESTAMP;
                RETURN NEW;
            END;
            $$ LANGUAGE plpgsql;

            DROP TRIGGER IF EXISTS trigger_update_client_updated_at ON "CLIENT";
            CREATE TRIGGER trigger_update_client_updated_at
                BEFORE UPDATE ON "CLIENT"
                FOR EACH ROW
                EXECUTE FUNCTION update_client_updated_at();
        `);

        // Migration for CLIENT table to add created_by if missing
        await pool.query(`
            DO $$ 
            BEGIN
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'CLIENT' AND column_name = 'created_by') THEN
                    ALTER TABLE "CLIENT" ADD COLUMN created_by VARCHAR(255);
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'CLIENT' AND column_name = 'sec_name') THEN
                    ALTER TABLE "CLIENT" ADD COLUMN sec_name VARCHAR(255);
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'CLIENT' AND column_name = 'sec_mobile') THEN
                    ALTER TABLE "CLIENT" ADD COLUMN sec_mobile VARCHAR(20);
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'CLIENT' AND column_name = 'sec_email') THEN
                    ALTER TABLE "CLIENT" ADD COLUMN sec_email VARCHAR(255);
                END IF;
            END $$;
        `);

        // Add comments for CLIENT table
        await pool.query(`
            COMMENT ON TABLE "CLIENT" IS 'Client information table storing company and contact details';
            COMMENT ON COLUMN "CLIENT".company_name IS 'Company or organization name';
            COMMENT ON COLUMN "CLIENT".client_code IS 'Unique client identifier code';
            COMMENT ON COLUMN "CLIENT".client_logo IS 'URL of client logo image stored in Cloudinary';
            COMMENT ON COLUMN "CLIENT".created_by IS 'Username/Name of the person who created this client';
        `);

        // Create PROJECT table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS "PROJECT" (
                "id" SERIAL PRIMARY KEY,
                "project_name" VARCHAR(255) NOT NULL,
                "project_code" VARCHAR(100) UNIQUE NOT NULL,
                "serial_no" VARCHAR(10),
           
                "inquiry_date" VARCHAR(20),
                "target_date" VARCHAR(20),
                "start_date" VARCHAR(20),
                "end_date" VARCHAR(20),
                "work_hour" VARCHAR(50) DEFAULT '0h',
                "net_time" VARCHAR(50) DEFAULT '0h',
                "status" VARCHAR(50) DEFAULT 'In Progress',
                "drive_link" TEXT,
                "category" VARCHAR(10),
                "client_code" VARCHAR(50),
                "sub_code" VARCHAR(50),
                "version" VARCHAR(10),
                "target_hour" NUMERIC(10, 2),
                "per_day_hour" NUMERIC(10, 2) DEFAULT 8.0,
                "month" VARCHAR(2),
                "year" VARCHAR(2),
                
                "priority" VARCHAR(10),
                "project_photo" TEXT,
               
                "hold_date" VARCHAR(20), -- Date when project was put on hold
                "hold_reason" TEXT, -- Reason for putting project on hold
               
                
                "created_at" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                "updated_at" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                "created_by" VARCHAR(255)
            );
        `);




        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_project_name ON "PROJECT"(project_name);
            CREATE INDEX IF NOT EXISTS idx_project_code ON "PROJECT"(project_code);
            CREATE INDEX IF NOT EXISTS idx_project_status ON "PROJECT"(status);
           
            CREATE INDEX IF NOT EXISTS idx_project_category ON "PROJECT"(category);

            CREATE OR REPLACE FUNCTION update_project_updated_at()
            RETURNS TRIGGER AS $$
            BEGIN
                NEW.updated_at = CURRENT_TIMESTAMP;
                RETURN NEW;
            END;
            $$ LANGUAGE plpgsql;

            DROP TRIGGER IF EXISTS trigger_update_project_updated_at ON "PROJECT";
            CREATE TRIGGER trigger_update_project_updated_at
                BEFORE UPDATE ON "PROJECT"
                FOR EACH ROW
                EXECUTE FUNCTION update_project_updated_at();

            COMMENT ON TABLE "PROJECT" IS 'Project management table storing project details and tracking information';
            COMMENT ON COLUMN "PROJECT".created_by IS 'Username/Name of the person who created this project';
        `);
        console.log('✅ PROJECT table created/verified');

        await pool.query(`
            ALTER TABLE "PROJECT"
            ADD COLUMN IF NOT EXISTS process_ids JSONB DEFAULT '[]'::jsonb;
        `);

        await pool.query(`
            ALTER TABLE "PROJECT"
            ADD COLUMN IF NOT EXISTS process_map JSONB DEFAULT '{}'::jsonb;
        `);

        await pool.query(`
            ALTER TABLE "PROJECT"
            ADD COLUMN IF NOT EXISTS custom_process JSONB DEFAULT '[]'::jsonb;
        `);
        console.log('✅ PROJECT.custom_process column created/verified');

        // Migrate legacy PROJECT.link → drive_link, then drop link
        await pool.query(`
            DO $$
            BEGIN
                IF EXISTS (
                    SELECT 1
                    FROM information_schema.columns
                    WHERE table_schema = 'public'
                      AND table_name = 'PROJECT'
                      AND column_name = 'link'
                ) THEN
                    UPDATE "PROJECT"
                    SET drive_link = link
                    WHERE (drive_link IS NULL OR BTRIM(drive_link) = '')
                      AND link IS NOT NULL
                      AND BTRIM(link) <> '';

                    ALTER TABLE "PROJECT" DROP COLUMN link;
                END IF;
            END $$;
        `);

        await pool.query(`
            ALTER TABLE "PROJECT"
            ADD COLUMN IF NOT EXISTS group_link TEXT;
        `);

        // In-app File Manager folder link for the project root
        await pool.query(`
            ALTER TABLE "PROJECT"
            ADD COLUMN IF NOT EXISTS filemanager_link TEXT;
        `);

        // Backfill from drive_link when it already holds an FM path
        await pool.query(`
            UPDATE "PROJECT"
            SET filemanager_link = drive_link
            WHERE (filemanager_link IS NULL OR BTRIM(filemanager_link) = '')
              AND drive_link IS NOT NULL
              AND BTRIM(drive_link) <> ''
              AND (
                drive_link LIKE '/fileManager/%'
                OR drive_link LIKE '%/fileManager/folders/%'
              );
        `);
        console.log('✅ PROJECT.filemanager_link column created/verified');

        await pool.query(`
            ALTER TABLE "PROJECT"
            ADD COLUMN IF NOT EXISTS assigned_users_display TEXT;
        `);

        await pool.query(`
            ALTER TABLE "PROJECT"
            ADD COLUMN IF NOT EXISTS overall_completion NUMERIC(6, 2) DEFAULT 0;
        `);
        console.log('✅ PROJECT.overall_completion column created/verified');


        // Create PCB table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS "PCB" (
                "id" SERIAL PRIMARY KEY,
                "pcb_code" VARCHAR(100) UNIQUE NOT NULL,
                "project_id" INTEGER REFERENCES "PROJECT"(id) ON DELETE SET NULL,
                "project_code" VARCHAR(100),
                "project_name" VARCHAR(255),
                
                "link" TEXT,
                "pcb_photo" TEXT,
                "section_index" INTEGER DEFAULT 2,
                "created_at" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                "updated_at" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                "created_by" VARCHAR(255)
            );

            
        `);


        console.log('✅ PCB table created/verified');

        // Existing DBs may predate project_id — CREATE TABLE IF NOT EXISTS will not add it
        await pool.query(`
            ALTER TABLE "PCB"
            ADD COLUMN IF NOT EXISTS project_id INTEGER REFERENCES "PROJECT"(id) ON DELETE SET NULL;
        `);
        await pool.query(`
            UPDATE "PCB" pcb
            SET project_id = p.id
            FROM "PROJECT" p
            WHERE pcb.project_id IS NULL
              AND pcb.project_code IS NOT NULL
              AND TRIM(pcb.project_code) <> ''
              AND LOWER(TRIM(pcb.project_code)) = LOWER(TRIM(p.project_code));
        `);
        console.log('✅ PCB.project_id column created/verified');

        await pool.query(`
            ALTER TABLE "PCB" DROP COLUMN IF EXISTS process_ids;
            ALTER TABLE "PCB" DROP COLUMN IF EXISTS checked_tasks;
            ALTER TABLE "PCB" DROP COLUMN IF EXISTS checked_task;
            ALTER TABLE "PCB" ADD COLUMN IF NOT EXISTS process_map JSONB DEFAULT '{}'::jsonb;
            
        `);

     
        await pool.query(`
            ALTER TABLE "PCB"
            ADD COLUMN IF NOT EXISTS custom_process JSONB DEFAULT '[]'::jsonb;
        `);
        console.log('✅ PCB.custom_process column created/verified');
        

        // Resync PCB id sequence (imports/restores can leave SERIAL behind MAX(id))
        try {
            const pcbMaxResult = await pool.query('SELECT COALESCE(MAX(id), 0) AS max_id FROM "PCB"');
            const pcbMaxId = Math.max(parseInt(pcbMaxResult.rows[0].max_id, 10) || 0, 1);
            const pcbSeqResult = await pool.query(`SELECT pg_get_serial_sequence('"PCB"', 'id') AS sequence_name`);
            const pcbSequenceName = pcbSeqResult.rows[0]?.sequence_name;
            if (pcbSequenceName) {
                await pool.query('SELECT setval($1, $2, true)', [pcbSequenceName, pcbMaxId]);
                console.log(`✅ PCB id sequence synced to ${pcbMaxId}`);
            }
        } catch (seqErr) {
            console.warn('⚠ PCB id sequence sync skipped:', seqErr.message);
        }

        // Create project_process_checked table (tracks checked processes per project)
        await pool.query(`
            CREATE TABLE IF NOT EXISTS PROJECTS_PROCESS_CHECKED (
                id SERIAL PRIMARY KEY,
                project_id INTEGER REFERENCES "PROJECT"(id) ON DELETE CASCADE,
                project_code VARCHAR(100),
                main_or_pcb_id VARCHAR(100),
                total_process_id JSONB DEFAULT '[]'::jsonb,
                checked_id JSONB DEFAULT '[]'::jsonb,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

           

        `);

        await pool.query(`
            ALTER TABLE projects_process_checked
            ADD COLUMN IF NOT EXISTS main_or_pcb_id VARCHAR(100);
        `);
        await pool.query(`
            DO $$
            BEGIN
                IF EXISTS (
                    SELECT 1
                    FROM information_schema.columns
                    WHERE table_schema = 'public'
                      AND table_name = 'projects_process_checked'
                      AND column_name = 'main_or_pcb_id'
                      AND data_type = 'integer'
                ) THEN
                    ALTER TABLE projects_process_checked
                    ALTER COLUMN main_or_pcb_id TYPE VARCHAR(100)
                    USING main_or_pcb_id::text;
                END IF;
            END $$;
        `);
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_projects_process_checked_main_or_pcb_id
            ON projects_process_checked (project_id, main_or_pcb_id);
        `);

        await pool.query(`
            UPDATE projects_process_checked
            SET main_or_pcb_id = 'main'
            WHERE main_or_pcb_id = 'main_process';
        `);

        await pool.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_process_checked_project_scope
            ON projects_process_checked (project_id, COALESCE(main_or_pcb_id, ''));
        `);

        console.log('✅ projects_process_checked table created/verified');

        try {
            const ppcMaxResult = await pool.query(
                'SELECT COALESCE(MAX(id), 0) AS max_id FROM projects_process_checked',
            );
            const ppcMaxId = parseInt(ppcMaxResult.rows[0].max_id, 10) || 0;
            const ppcSeqResult = await pool.query(
                `SELECT pg_get_serial_sequence('projects_process_checked', 'id') AS sequence_name`,
            );
            const ppcSequenceName = ppcSeqResult.rows[0]?.sequence_name;
            if (ppcSequenceName) {
                await pool.query('SELECT setval($1, $2, true)', [ppcSequenceName, Math.max(ppcMaxId, 1)]);
                console.log(`✅ projects_process_checked id sequence synced to ${Math.max(ppcMaxId, 1)}`);
            }
        } catch (seqErr) {
            console.warn('⚠ projects_process_checked id sequence sync skipped:', seqErr.message);
        }









        // Task list history: log when tasks are checked/unchecked (for timetrack task list history)
        await pool.query(`
            CREATE TABLE IF NOT EXISTS task_list_history (
                id SERIAL PRIMARY KEY,
                process_id INTEGER NOT NULL,
                user_id INTEGER,
                checked BOOLEAN NOT NULL,
                project_code VARCHAR(100),
                project_id INTEGER,
                pcb_id INTEGER,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS idx_task_list_history_project_code ON task_list_history(project_code);
            CREATE INDEX IF NOT EXISTS idx_task_list_history_process_id ON task_list_history(process_id);
            CREATE INDEX IF NOT EXISTS idx_task_list_history_user_id ON task_list_history(user_id);
            CREATE INDEX IF NOT EXISTS idx_task_list_history_created_at ON task_list_history(created_at DESC);
        `);
        console.log('✅ task_list_history table created/verified');

        // Timesheet log: store update/delete snapshots for timesheet rows
        await pool.query(`
            CREATE TABLE IF NOT EXISTS timesheet_log (
                id SERIAL PRIMARY KEY,
                timesheet_id INTEGER NOT NULL,
                action VARCHAR(20) NOT NULL,
                project_code VARCHAR(100),
                subject_user_id INTEGER,
                actor_user_id INTEGER,
                actor_username VARCHAR(100),
                subject_username VARCHAR(100),
                old_value JSONB,
                new_value JSONB,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            ALTER TABLE timesheet_log
            ADD COLUMN IF NOT EXISTS actor_username VARCHAR(100);
            ALTER TABLE timesheet_log
            ADD COLUMN IF NOT EXISTS subject_username VARCHAR(100);
            CREATE INDEX IF NOT EXISTS idx_timesheet_log_timesheet_id ON timesheet_log(timesheet_id);
            CREATE INDEX IF NOT EXISTS idx_timesheet_log_project_code ON timesheet_log(project_code);
            CREATE INDEX IF NOT EXISTS idx_timesheet_log_action ON timesheet_log(action);
            CREATE INDEX IF NOT EXISTS idx_timesheet_log_actor_user_id ON timesheet_log(actor_user_id);
            CREATE INDEX IF NOT EXISTS idx_timesheet_log_created_at ON timesheet_log(created_at DESC);
        `);
        console.log('✅ timesheet_log table created/verified');

        // Create PRODUCTION table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS "PRODUCTION" (
                "id" SERIAL PRIMARY KEY,
                "project_name" VARCHAR(255),
                "project_code" VARCHAR(100),
                "pcb_code" VARCHAR(100),
                "lot_no" VARCHAR(100),
                "qty" VARCHAR(50),
                "production_code" VARCHAR(255),
                "bom_link" TEXT,
                "bom_file" TEXT,
                "requirementsheep_link" TEXT,
                "requirementsheep_file" TEXT,
                "gerber_link" TEXT,
                "gerber_file" TEXT,
                "stencil_link" TEXT,
                "stencil_file" TEXT,
                "sample_photo_link" TEXT,
                "sample_photo_file" TEXT,
                "testing_link" TEXT,
                "testing_file" TEXT,
                "prepare_person" VARCHAR(255),
                "dispatch_target_date" VARCHAR(50),
                "dispatch_date" VARCHAR(50),
                "acdc_target_date" VARCHAR(50),
                "emble_target_date" VARCHAR(50),
                "status" VARCHAR(50) DEFAULT 'Scheduled',
                "place" VARCHAR(255),
                "comment" TEXT,
                "odoo_link" TEXT,
                "created_at" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                "updated_at" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                "created_by" VARCHAR(255)
            );

            CREATE INDEX IF NOT EXISTS idx_production_code ON "PRODUCTION"(production_code);
            CREATE INDEX IF NOT EXISTS idx_production_project_code ON "PRODUCTION"(project_code);

            COMMENT ON TABLE "PRODUCTION" IS 'Production job tracking table';
        `);
        console.log('✅ PRODUCTION table created/verified');

        // Migration for PRODUCTION table to add production_done_date if missing
        await pool.query(`
            DO $$ 
            BEGIN
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'PRODUCTION' AND column_name = 'production_done_date') THEN
                    ALTER TABLE "PRODUCTION" ADD COLUMN production_done_date VARCHAR(50);
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'PRODUCTION' AND column_name = 'production_photos') THEN
                    ALTER TABLE "PRODUCTION" ADD COLUMN production_photos TEXT;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'PRODUCTION' AND column_name = 'serial_no') THEN
                    ALTER TABLE "PRODUCTION" ADD COLUMN serial_no VARCHAR(50);
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'PRODUCTION' AND column_name = 'panel_gerber_link') THEN
                    ALTER TABLE "PRODUCTION" ADD COLUMN panel_gerber_link TEXT;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'PRODUCTION' AND column_name = 'panel_gerber_file') THEN
                    ALTER TABLE "PRODUCTION" ADD COLUMN panel_gerber_file TEXT;
                END IF;
                -- File Manager paths (select folder / upload); *_link stays for the openable link
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'PRODUCTION' AND column_name = 'filemanager_bom') THEN
                    ALTER TABLE "PRODUCTION" ADD COLUMN filemanager_bom TEXT;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'PRODUCTION' AND column_name = 'filemanager_requirementsheep') THEN
                    ALTER TABLE "PRODUCTION" ADD COLUMN filemanager_requirementsheep TEXT;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'PRODUCTION' AND column_name = 'filemanager_gerber') THEN
                    ALTER TABLE "PRODUCTION" ADD COLUMN filemanager_gerber TEXT;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'PRODUCTION' AND column_name = 'filemanager_panel_gerber') THEN
                    ALTER TABLE "PRODUCTION" ADD COLUMN filemanager_panel_gerber TEXT;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'PRODUCTION' AND column_name = 'filemanager_stencil') THEN
                    ALTER TABLE "PRODUCTION" ADD COLUMN filemanager_stencil TEXT;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'PRODUCTION' AND column_name = 'filemanager_production_photos') THEN
                    ALTER TABLE "PRODUCTION" ADD COLUMN filemanager_production_photos TEXT;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'PRODUCTION' AND column_name = 'filemanager_testing') THEN
                    ALTER TABLE "PRODUCTION" ADD COLUMN filemanager_testing TEXT;
                END IF;
            END $$;
        `);
        console.log('✅ PRODUCTION table migrated (added extra columns if missing)');

        // Create TIMESHEET table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS "TIMESHEET" (
                "id" SERIAL PRIMARY KEY,
                "project_code" VARCHAR(255),
                "project_id" INTEGER,
                "project_type" VARCHAR(100),
                "category_letter" VARCHAR(10),
                "process_name" VARCHAR(255),
                "process_id" INTEGER,
                "date" VARCHAR(20),
                "start_time" VARCHAR(100),
                "stop_time" VARCHAR(100),
                "duration" VARCHAR(50),
                "project_by" VARCHAR(255),
                "user_id" INTEGER,
                "user_name" VARCHAR(255),
                "notes" TEXT,
                "checked_tasks" TEXT,
                "task_id" INTEGER,
                "task_serial_number" VARCHAR(50),
                "created_at" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                "updated_at" TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            -- Migration to rename project_name to project_code if it exists
            DO $$ 
            BEGIN
                IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'TIMESHEET' AND column_name = 'project_name') THEN
                    ALTER TABLE "TIMESHEET" RENAME COLUMN project_name TO project_code;
                END IF;
            END $$;

            -- Migration to ensure the date column is stored as character data for UI compatibility
            DO $$
            BEGIN
                IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'TIMESHEET' AND column_name = 'date') THEN
                    ALTER TABLE "TIMESHEET" ALTER COLUMN "date" TYPE VARCHAR(20) USING "date"::text;
                END IF;
            END $$;

            -- Migration to change start_time and stop_time to VARCHAR if they are TIMESTAMP
            DO $$ 
            BEGIN
                IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'TIMESHEET' AND column_name = 'start_time' AND data_type = 'timestamp without time zone') THEN
                    ALTER TABLE "TIMESHEET" ALTER COLUMN start_time TYPE VARCHAR(100) USING start_time::text;
                    ALTER TABLE "TIMESHEET" ALTER COLUMN stop_time TYPE VARCHAR(100) USING stop_time::text;
                END IF;
            END $$;

            -- Migration to add project_id, category_letter, process_id, date if missing
            DO $$ 
            BEGIN
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'TIMESHEET' AND column_name = 'project_id') THEN
                    ALTER TABLE "TIMESHEET" ADD COLUMN project_id INTEGER;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'TIMESHEET' AND column_name = 'category_letter') THEN
                    ALTER TABLE "TIMESHEET" ADD COLUMN category_letter VARCHAR(10);
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'TIMESHEET' AND column_name = 'process_id') THEN
                    ALTER TABLE "TIMESHEET" ADD COLUMN process_id INTEGER;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'TIMESHEET' AND column_name = 'date') THEN
                    ALTER TABLE "TIMESHEET" ADD COLUMN "date" VARCHAR(20);
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'TIMESHEET' AND column_name = 'checked_tasks') THEN
                    ALTER TABLE "TIMESHEET" ADD COLUMN checked_tasks TEXT;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'TIMESHEET' AND column_name = 'user_name') THEN
                    ALTER TABLE "TIMESHEET" ADD COLUMN user_name VARCHAR(255);
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'TIMESHEET' AND column_name = 'task_id') THEN
                    ALTER TABLE "TIMESHEET" ADD COLUMN task_id INTEGER;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'TIMESHEET' AND column_name = 'task_serial_number') THEN
                    ALTER TABLE "TIMESHEET" ADD COLUMN task_serial_number VARCHAR(50);
                END IF;
              
            END $$;

            -- Remove TIMESHEET → users FK; username is stored directly on TIMESHEET
            DO $$
            BEGIN
                IF EXISTS (
                    SELECT 1 FROM information_schema.table_constraints
                    WHERE table_name = 'TIMESHEET'
                      AND constraint_name = 'TIMESHEET_user_id_fkey'
                ) THEN
                    ALTER TABLE "TIMESHEET" DROP CONSTRAINT "TIMESHEET_user_id_fkey";
                END IF;
            END $$;

            -- Backfill user_name from personal_details for existing rows (one-time best effort)
            UPDATE "TIMESHEET" t
            SET user_name = pd.username
            FROM personal_details pd
            WHERE t.user_id = pd.id
              AND (t.user_name IS NULL OR TRIM(t.user_name) = '');

            -- Migration to change start_time and stop_time to VARCHAR if they are TIMESTAMP
            DO $$ 
            BEGIN
                IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'TIMESHEET' AND column_name = 'start_time' AND data_type = 'timestamp without time zone') THEN
                    ALTER TABLE "TIMESHEET" ALTER COLUMN start_time TYPE VARCHAR(100) USING start_time::text;
                    ALTER TABLE "TIMESHEET" ALTER COLUMN stop_time TYPE VARCHAR(100) USING stop_time::text;
                END IF;
            END $$;

            -- Migration to add project_id, category_letter, process_id, checked_tasks if missing
            DO $$ 
            BEGIN
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'TIMESHEET' AND column_name = 'project_id') THEN
                    ALTER TABLE "TIMESHEET" ADD COLUMN project_id INTEGER;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'TIMESHEET' AND column_name = 'category_letter') THEN
                    ALTER TABLE "TIMESHEET" ADD COLUMN category_letter VARCHAR(10);
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'TIMESHEET' AND column_name = 'process_id') THEN
                    ALTER TABLE "TIMESHEET" ADD COLUMN process_id INTEGER;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'TIMESHEET' AND column_name = 'checked_tasks') THEN
                    ALTER TABLE "TIMESHEET" ADD COLUMN checked_tasks TEXT;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'TIMESHEET' AND column_name = 'user_name') THEN
                    ALTER TABLE "TIMESHEET" ADD COLUMN user_name VARCHAR(255);
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'TIMESHEET' AND column_name = 'task_id') THEN
                    ALTER TABLE "TIMESHEET" ADD COLUMN task_id INTEGER;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'TIMESHEET' AND column_name = 'task_serial_number') THEN
                    ALTER TABLE "TIMESHEET" ADD COLUMN task_serial_number VARCHAR(50);
                END IF;
           
            END $$;

            CREATE INDEX IF NOT EXISTS idx_timesheet_project_code ON "TIMESHEET"(project_code);
            CREATE INDEX IF NOT EXISTS idx_timesheet_user_id ON "TIMESHEET"(user_id);
            CREATE INDEX IF NOT EXISTS idx_timesheet_start_time ON "TIMESHEET"(start_time);
            CREATE INDEX IF NOT EXISTS idx_timesheet_task_id ON "TIMESHEET"(task_id);
            CREATE INDEX IF NOT EXISTS idx_timesheet_task_serial_number ON "TIMESHEET"(task_serial_number);

            COMMENT ON TABLE "TIMESHEET" IS 'Table for tracking time spent on projects and processes';
        `);

        try {
            const tsMaxResult = await pool.query(
                'SELECT COALESCE(MAX(id), 0) AS max_id FROM "TIMESHEET"',
            );
            const tsMaxId = Math.max(parseInt(tsMaxResult.rows[0].max_id, 10) || 0, 1);
            const tsSeqResult = await pool.query(
                `SELECT pg_get_serial_sequence('"TIMESHEET"', 'id') AS sequence_name`,
            );
            const tsSequenceName = tsSeqResult.rows[0]?.sequence_name;
            if (tsSequenceName) {
                await pool.query('SELECT setval($1, $2, true)', [
                    tsSequenceName,
                    tsMaxId,
                ]);
                console.log(`✅ TIMESHEET id sequence synced to ${tsMaxId}`);
            }
        } catch (seqErr) {
            console.warn('⚠ TIMESHEET id sequence sync skipped:', seqErr.message);
        }

        console.log('✅ TIMESHEET table created/verified');


        // Create financial_years table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS financial_years (
                id SERIAL PRIMARY KEY,
                year_code VARCHAR(10) UNIQUE NOT NULL,
                start_year INTEGER NOT NULL,
                end_year INTEGER NOT NULL,
                search_code VARCHAR(4),
                is_active BOOLEAN DEFAULT TRUE,
                is_current BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Add search_code column + backfill for existing databases
        await pool.query(`
            DO $$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1
                    FROM information_schema.columns
                    WHERE table_name = 'financial_years'
                      AND column_name = 'search_code'
                ) THEN
                    ALTER TABLE financial_years ADD COLUMN search_code VARCHAR(4);
                END IF;
            END $$;
        `);

        await pool.query(`
            UPDATE financial_years
            SET search_code = RIGHT(start_year::text, 2) || RIGHT(end_year::text, 2)
            WHERE search_code IS NULL OR search_code = '';
        `);

        // Add is_current column for existing databases
        await pool.query(`
            DO $$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1
                    FROM information_schema.columns
                    WHERE table_name = 'financial_years'
                      AND column_name = 'is_current'
                ) THEN
                    ALTER TABLE financial_years ADD COLUMN is_current BOOLEAN DEFAULT FALSE;
                END IF;
            END $$;
        `);

        // Drop legacy is_folder from financial_years (folder flag lives on FY file-manager table)
        await pool.query(`
            DO $$
            BEGIN
                IF EXISTS (
                    SELECT 1
                    FROM information_schema.columns
                    WHERE table_name = 'financial_years'
                      AND column_name = 'is_folder'
                ) THEN
                    ALTER TABLE financial_years DROP COLUMN is_folder;
                END IF;
            END $$;
        `);

        // Create index for financial_years
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_financial_years_year_code ON financial_years(year_code);
            CREATE INDEX IF NOT EXISTS idx_financial_years_is_active ON financial_years(is_active);
            CREATE INDEX IF NOT EXISTS idx_financial_years_is_current ON financial_years(is_current);
        `);

        // Insert default financial years if table is empty
        const existingYears = await pool.query('SELECT COUNT(*) FROM financial_years');
        if (parseInt(existingYears.rows[0].count) === 0) {
            const currentYear = new Date().getFullYear();
            const defaultYears = [];

            // Add years from 2020 to current + 2 years
            for (let year = 2020; year <= currentYear + 2; year++) {
                const nextYear = year + 1;
                const yearCode = `${year}-${nextYear.toString().slice(-2)}`;
                defaultYears.push(`('${yearCode}', ${year}, ${nextYear})`);
            }

            if (defaultYears.length > 0) {
                await pool.query(`
                    INSERT INTO financial_years (year_code, start_year, end_year)
                    VALUES ${defaultYears.join(', ')}
                    ON CONFLICT (year_code) DO NOTHING
                `);
            }
        }

        // Ensure current financial year exists (auto-add if missing)
        const now = new Date();
        const month = now.getMonth() + 1; // 1-12
        const year = now.getFullYear();

        let currentStartYear, currentEndYear, currentYearCode;

        if (month >= 4) {
            // April onwards - current year to next year (e.g., 2024-25)
            currentStartYear = year;
            currentEndYear = year + 1;
            currentYearCode = `${currentStartYear}-${currentEndYear.toString().slice(-2)}`;
        } else {
            // January to March - previous year to current year (e.g., 2023-24)
            currentStartYear = year - 1;
            currentEndYear = year;
            currentYearCode = `${currentStartYear}-${currentEndYear.toString().slice(-2)}`;
        }

        // Check if current financial year exists, if not add it
        const currentFYCheck = await pool.query(
            'SELECT id FROM financial_years WHERE year_code = $1',
            [currentYearCode]
        );

        if (currentFYCheck.rows.length === 0) {
            await pool.query(
                'INSERT INTO financial_years (year_code, start_year, end_year, is_active, is_current) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (year_code) DO NOTHING',
                [currentYearCode, currentStartYear, currentEndYear, true, true]
            );
            console.log(`✅ Auto-added current financial year during initialization: ${currentYearCode}`);
        }

        // Only the calendar financial year is marked current
        await pool.query('UPDATE financial_years SET is_current = FALSE');
        await pool.query(
            'UPDATE financial_years SET is_current = TRUE WHERE year_code = $1',
            [currentYearCode]
        );

        console.log('✅ financial_years table created/verified');

        // Create HS_Status table (History/Status tracking table)
        await pool.query(`
            CREATE TABLE IF NOT EXISTS "HS_Status" (
                "id" SERIAL PRIMARY KEY,
                "project_id" INTEGER REFERENCES "PROJECT"(id) ON DELETE CASCADE,
                "project_code" VARCHAR(100),
                "old_status" VARCHAR(50),
                "current_status" VARCHAR(50),
                "date" VARCHAR(20),
                "reason_note" TEXT,
                "update_by" VARCHAR(255),
                "created_at" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                "update_time" TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Add migration to ensure columns exist
        await pool.query(`
            DO $$ 
            BEGIN
                -- Add project_id column if it doesn't exist
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'HS_Status' AND column_name = 'project_id') THEN
                    ALTER TABLE "HS_Status" ADD COLUMN project_id INTEGER REFERENCES "PROJECT"(id) ON DELETE CASCADE;
                END IF;

                -- Add project_code column if it doesn't exist
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'HS_Status' AND column_name = 'project_code') THEN
                    ALTER TABLE "HS_Status" ADD COLUMN project_code VARCHAR(100);
                END IF;

                -- Add old_status column if it doesn't exist
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'HS_Status' AND column_name = 'old_status') THEN
                    ALTER TABLE "HS_Status" ADD COLUMN old_status VARCHAR(50);
                END IF;

                -- Add current_status column if it doesn't exist
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'HS_Status' AND column_name = 'current_status') THEN
                    ALTER TABLE "HS_Status" ADD COLUMN current_status VARCHAR(50);
                END IF;

                -- Add date column if it doesn't exist
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'HS_Status' AND column_name = 'date') THEN
                    ALTER TABLE "HS_Status" ADD COLUMN date VARCHAR(20);
                END IF;

                -- Add reason_note column if it doesn't exist
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'HS_Status' AND column_name = 'reason_note') THEN
                    ALTER TABLE "HS_Status" ADD COLUMN reason_note TEXT;
                END IF;

                -- Add update_by column if it doesn't exist
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'HS_Status' AND column_name = 'update_by') THEN
                    ALTER TABLE "HS_Status" ADD COLUMN update_by VARCHAR(255);
                END IF;

                -- Add created_at column if it doesn't exist
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'HS_Status' AND column_name = 'created_at') THEN
                    ALTER TABLE "HS_Status" ADD COLUMN created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
                END IF;

                -- Add update_time column if it doesn't exist
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'HS_Status' AND column_name = 'update_time') THEN
                    ALTER TABLE "HS_Status" ADD COLUMN update_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
                END IF;
            END $$;
        `);

        // Create indexes for HS_Status table
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_hs_status_project_id ON "HS_Status"(project_id);
            CREATE INDEX IF NOT EXISTS idx_hs_status_project_code ON "HS_Status"(project_code);
            CREATE INDEX IF NOT EXISTS idx_hs_status_old_status ON "HS_Status"(old_status);
            CREATE INDEX IF NOT EXISTS idx_hs_status_current_status ON "HS_Status"(current_status);
            CREATE INDEX IF NOT EXISTS idx_hs_status_date ON "HS_Status"(date);
            CREATE INDEX IF NOT EXISTS idx_hs_status_update_by ON "HS_Status"(update_by);
            CREATE INDEX IF NOT EXISTS idx_hs_status_created_at ON "HS_Status"(created_at);
        `);

        // Create trigger to auto-update update_time
        await pool.query(`
            CREATE OR REPLACE FUNCTION update_hs_status_update_time()
            RETURNS TRIGGER AS $$
            BEGIN
                NEW.update_time = CURRENT_TIMESTAMP;
                RETURN NEW;
            END;
            $$ LANGUAGE plpgsql;

            DROP TRIGGER IF EXISTS trigger_update_hs_status_update_time ON "HS_Status";
            CREATE TRIGGER trigger_update_hs_status_update_time
                BEFORE UPDATE ON "HS_Status"
                FOR EACH ROW
                EXECUTE FUNCTION update_hs_status_update_time();
        `);

        // Add table comments
        await pool.query(`
            COMMENT ON TABLE "HS_Status" IS 'History/Status tracking table for project status changes';
            COMMENT ON COLUMN "HS_Status".project_id IS 'Foreign key reference to PROJECT table';
            COMMENT ON COLUMN "HS_Status".project_code IS 'Project code associated with the status change';
            COMMENT ON COLUMN "HS_Status".old_status IS 'Previous status before change';
            COMMENT ON COLUMN "HS_Status".current_status IS 'New status after change';
            COMMENT ON COLUMN "HS_Status".date IS 'Date when status change occurred';
            COMMENT ON COLUMN "HS_Status".reason_note IS 'Reason or notes for the status change';
            COMMENT ON COLUMN "HS_Status".update_by IS 'Username/Name of the person who made the status change';
            COMMENT ON COLUMN "HS_Status".created_at IS 'Timestamp when the record was created';
            COMMENT ON COLUMN "HS_Status".update_time IS 'Timestamp when the record was last updated';
        `);

        console.log('✅ HS_Status table created/verified');

        // Default / placeholder images per module (e.g. when a record has no photo)
        await pool.query(`
            CREATE TABLE IF NOT EXISTS "NO_IMAGE" (
                id SERIAL PRIMARY KEY,
                module_name VARCHAR(100) NOT NULL UNIQUE,
                image TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS idx_no_image_module_name
                ON "NO_IMAGE"(module_name);
        `);
        console.log('✅ NO_IMAGE table created/verified');

        console.log('✓ Database tables initialized successfully');
    } catch (error) {
        console.error('Error initializing database:', error);
        throw error;
    }
};

export {
    pool,
    initializeDatabase
};
