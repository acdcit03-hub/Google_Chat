/** Shared scope values for unified file_manager_items. */
export const FILE_MANAGER_SCOPES = {
    FILE_MANAGER: 'file_manager',
    FINANCIAL_YEAR: 'financial_year',
    PROJECT: 'project',
};

export const FILE_MANAGER_SCOPE_ALIASES = {
    file_manager: FILE_MANAGER_SCOPES.FILE_MANAGER,
    'file-manager': FILE_MANAGER_SCOPES.FILE_MANAGER,
    item: FILE_MANAGER_SCOPES.FILE_MANAGER,
    items: FILE_MANAGER_SCOPES.FILE_MANAGER,
    folder: FILE_MANAGER_SCOPES.FILE_MANAGER,
    fm: FILE_MANAGER_SCOPES.FILE_MANAGER,
    personal: FILE_MANAGER_SCOPES.FILE_MANAGER,

    financial_year: FILE_MANAGER_SCOPES.FINANCIAL_YEAR,
    'financial-year': FILE_MANAGER_SCOPES.FINANCIAL_YEAR,
    fy: FILE_MANAGER_SCOPES.FINANCIAL_YEAR,
    year: FILE_MANAGER_SCOPES.FINANCIAL_YEAR,

    project: FILE_MANAGER_SCOPES.PROJECT,
    project_file_manager: FILE_MANAGER_SCOPES.PROJECT,
    'project-file-manager': FILE_MANAGER_SCOPES.PROJECT,
    project_fm: FILE_MANAGER_SCOPES.PROJECT,
};

export function normalizeFileManagerScope(raw) {
    const key = String(raw || '')
        .trim()
        .toLowerCase();
    return FILE_MANAGER_SCOPE_ALIASES[key] || null;
}
