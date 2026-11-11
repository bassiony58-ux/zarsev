/**
 * ZARSEV — Manufacturer Permissions Matrix
 * Centralized Role-Based Access Control (RBAC) Specification
 * Distinguishes between global system role (role) and facility sub-role (sub_role).
 */

const SUB_ROLES = Object.freeze({
    OWNER: 'OWNER',
    SALES: 'SALES',
    PRODUCTION: 'PRODUCTION',
    EXPORT: 'EXPORT'
});

const ALL_SUB_ROLES = Object.freeze(Object.values(SUB_ROLES));

const PERMISSIONS = Object.freeze({
    // Team Management
    TEAM_VIEW: {
        action: 'TEAM_VIEW',
        description: 'عرض قائمة أعضاء فريق المصنع والدعوات وإحصائيات المقاعد',
        allowedSubRoles: [SUB_ROLES.OWNER]
    },
    TEAM_INVITE: {
        action: 'TEAM_INVITE',
        description: 'إرسال دعوة جديدة للانضمام لفريق المصنع',
        allowedSubRoles: [SUB_ROLES.OWNER]
    },
    TEAM_REVOKE_INVITE: {
        action: 'TEAM_REVOKE_INVITE',
        description: 'إلغاء دعوة معلقة قبل قبولها',
        allowedSubRoles: [SUB_ROLES.OWNER]
    },
    TEAM_CHANGE_ROLE: {
        action: 'TEAM_CHANGE_ROLE',
        description: 'تعديل الدور الفرعي لأحد أعضاء الفريق',
        allowedSubRoles: [SUB_ROLES.OWNER]
    },
    TEAM_DEACTIVATE_USER: {
        action: 'TEAM_DEACTIVATE_USER',
        description: 'تعطيل حساب مستخدم بالفريق ومنعه من الدخول',
        allowedSubRoles: [SUB_ROLES.OWNER]
    },
    TEAM_TRANSFER_OWNERSHIP: {
        action: 'TEAM_TRANSFER_OWNERSHIP',
        description: 'نقل ملكية حساب المنشأة لمستخدم آخر نشط مع تأكيد الهوية',
        allowedSubRoles: [SUB_ROLES.OWNER]
    },

    // Trade & Quotations
    RFQ_VIEW: {
        action: 'RFQ_VIEW',
        description: 'مشاهدة طلبات عروض الأسعار (RFQ) المخصصة للمصنع',
        allowedSubRoles: [SUB_ROLES.OWNER, SUB_ROLES.SALES, SUB_ROLES.EXPORT]
    },
    RFQ_CHANGE_STATUS: {
        action: 'RFQ_CHANGE_STATUS',
        description: 'تغيير حالة طلب عرض السعر (قبول، رفض، إلغاء)',
        allowedSubRoles: [SUB_ROLES.OWNER, SUB_ROLES.SALES]
    },
    QUOTATION_CREATE: {
        action: 'QUOTATION_CREATE',
        description: 'تقديم وإنشاء عرض سعر ملزم للعميل',
        allowedSubRoles: [SUB_ROLES.OWNER, SUB_ROLES.SALES]
    },
    QUOTATION_VIEW: {
        action: 'QUOTATION_VIEW',
        description: 'مشاهدة عروض الأسعار المقدمة وتفاصيلها',
        allowedSubRoles: [SUB_ROLES.OWNER, SUB_ROLES.SALES, SUB_ROLES.EXPORT]
    },

    // Catalog & Production
    PRODUCT_UPLOAD: {
        action: 'PRODUCT_UPLOAD',
        description: 'رفع ملفات الكتالوج والمنتجات الجديدة',
        allowedSubRoles: [SUB_ROLES.OWNER, SUB_ROLES.PRODUCTION]
    },
    PRODUCT_SUBMIT_REVIEW: {
        action: 'PRODUCT_SUBMIT_REVIEW',
        description: 'إرسال المنتجات للمراجعة والاعتماد النهائي',
        allowedSubRoles: [SUB_ROLES.OWNER, SUB_ROLES.PRODUCTION]
    },
    PRODUCT_VIEW: {
        action: 'PRODUCT_VIEW',
        description: 'مشاهدة كتالوج ومنتجات المصنع',
        allowedSubRoles: [SUB_ROLES.OWNER, SUB_ROLES.PRODUCTION, SUB_ROLES.SALES, SUB_ROLES.EXPORT]
    },

    // Documents & Compliance
    DOC_MANAGE_LEGAL: {
        action: 'DOC_MANAGE_LEGAL',
        description: 'إدارة ورفع وحذف السجلات التجارية والمستندات القانونية والضريبية للمصنع',
        allowedSubRoles: [SUB_ROLES.OWNER]
    },
    DOC_VIEW_EXPORT: {
        action: 'DOC_VIEW_EXPORT',
        description: 'مشاهدة وتنزيل شهادات الجودة ومستندات التصدير والشحن المصرح بها',
        allowedSubRoles: [SUB_ROLES.OWNER, SUB_ROLES.EXPORT]
    }
});

/**
 * Check if a sub-role can perform a specific action
 * Deny by default: returns false if subRole is invalid or not in allowed list.
 */
function canPerform(subRole, actionKey) {
    if (!subRole || !ALL_SUB_ROLES.includes(subRole)) return false;
    const perm = PERMISSIONS[actionKey];
    if (!perm) return false;
    return perm.allowedSubRoles.includes(subRole);
}

/**
 * Get all actions a sub-role is allowed to perform
 */
function getAllowedActions(subRole) {
    if (!subRole || !ALL_SUB_ROLES.includes(subRole)) return [];
    return Object.keys(PERMISSIONS).filter(actionKey => canPerform(subRole, actionKey));
}

module.exports = {
    SUB_ROLES,
    ALL_SUB_ROLES,
    PERMISSIONS,
    canPerform,
    getAllowedActions
};
