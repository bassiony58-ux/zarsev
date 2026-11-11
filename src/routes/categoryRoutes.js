const express = require('express');
const router = express.Router();
const dbClient = require('../db/dbClient');

/**
 * Recursively builds a category tree supporting arbitrary hierarchy depth.
 * Preserves ordering by name_ar and parent-child relationships.
 */
function buildCategoryHierarchy(roots, nonRoots) {
    const childrenByParent = new Map();
    for (const sub of nonRoots) {
        if (!childrenByParent.has(sub.parent_id)) {
            childrenByParent.set(sub.parent_id, []);
        }
        childrenByParent.get(sub.parent_id).push(sub);
    }

    function attachChildren(node) {
        const directChildren = childrenByParent.get(node.id) || [];
        return {
            ...node,
            subcategories: directChildren.map(child => attachChildren(child))
        };
    }

    return roots.map(root => attachChildren(root));
}

// Get categories tree
router.get('/', async (req, res) => {
    try {
        const dbOpts = req.dbClientOptions || {};
        const categories = await dbClient.queryAll('SELECT * FROM categories WHERE parent_id IS NULL ORDER BY name_ar ASC', [], dbOpts);
        const subcategories = await dbClient.queryAll('SELECT * FROM categories WHERE parent_id IS NOT NULL ORDER BY name_ar ASC', [], dbOpts);

        const tree = buildCategoryHierarchy(categories, subcategories);

        return res.json({
            success: true,
            categories: tree,
            flat: [...categories, ...subcategories]
        });
    } catch (err) {
        console.error('[categoryRoutes] Error fetching categories:', err.message);
        return res.status(500).json({
            success: false,
            error: 'خطأ في استرجاع التصنيفات من قاعدة البيانات'
        });
    }
});

router.buildCategoryHierarchy = buildCategoryHierarchy;
module.exports = router;
