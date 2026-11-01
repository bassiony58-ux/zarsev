const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');

// Get categories tree
router.get('/', (req, res) => {
    const db = getDb();
    const categories = db.prepare('SELECT * FROM categories WHERE parent_id IS NULL ORDER BY name_ar').all();
    const subcategories = db.prepare('SELECT * FROM categories WHERE parent_id IS NOT NULL ORDER BY name_ar').all();

    const tree = categories.map(cat => ({
        ...cat,
        subcategories: subcategories.filter(sub => sub.parent_id === cat.id)
    }));

    res.json({
        success: true,
        categories: tree,
        flat: [...categories, ...subcategories]
    });
});

module.exports = router;
