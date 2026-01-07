const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');

// ============================================
// INITIALIZE APP & SERVER
// ============================================
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST", "PUT", "PATCH", "DELETE"]
    }
});
const PORT = process.env.PORT || 3000;

// ============================================
// INITIALIZE SUPABASE
// ============================================
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

if (SUPABASE_URL && SUPABASE_KEY) {
    console.log("✅ Supabase credentials loaded successfully");
} else {
    console.error("❌ Missing Supabase credentials! Check Environment Variables.");
    process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Test connectivity
(async () => {
    const { data, error } = await supabase.from('restaurants').select('*').limit(1);
    if (error) {
        console.error("❌ Supabase test query failed:", error.message);
    } else {
        console.log("✅ Supabase connected successfully");
    }
})();

// ============================================
// MIDDLEWARE
// ============================================
app.use(express.json());
app.use(express.static('public'));

// ============================================
// HEALTH CHECK
// ============================================
app.get('/health', (req, res) => {
    res.json({ 
        status: 'healthy', 
        timestamp: new Date().toISOString(),
        connections: io.engine.clientsCount
    });
});

// ============================================
// WHATSAPP MESSAGE FUNCTION
// ============================================
async function sendWhatsAppMessage(recipientPhone, message) {
    try {
        const formattedPhone = recipientPhone.replace(/[^0-9]/g, '');
        
        const response = await axios.post(
            `https://graph.facebook.com/v24.0/${process.env.META_PHONE_ID}/messages`,
            {
                messaging_product: 'whatsapp',
                to: formattedPhone,
                type: 'text',
                text: { body: message }
            },
            {
                headers: {
                    'Authorization': `Bearer ${process.env.META_ACCESS_TOKEN}`,
                    'Content-Type': 'application/json'
                }
            }
        );
        
        console.log(`✅ WhatsApp sent to ${formattedPhone}`);
        return { success: true, messageId: response.data.messages[0].id };
        
    } catch (error) {
        console.error('❌ WhatsApp send failed:', error.response?.data || error.message);
        return { success: false, error: error.message };
    }
}

// ============================================
// STATUS MESSAGE HELPER
// ============================================
function getStatusMessage(status, orderNumber) {
    const messages = {
        'new': 
            `📝 *Order Received* #${orderNumber}\n\n` +
            `We've received your order!`,
        'confirmed': 
            `✅ *Order Confirmed* #${orderNumber}\n\n` +
            `Your order has been confirmed and sent to the kitchen!\n\n` +
            `We'll notify you when it's ready.`,
        'preparing': 
            `👨‍🍳 *Preparing Your Order* #${orderNumber}\n\n` +
            `Our chefs are cooking your meal right now!\n\n` +
            `Estimated time: 15-20 minutes`,
        'ready': 
            `🎉 *Order Ready for Pickup!* #${orderNumber}\n\n` +
            `Your order is ready!\n\n` +
            `📍 Please collect within 15 minutes\n\n` +
            `See you soon!`,
        'out_for_delivery': 
            `🚗 *Out for Delivery* #${orderNumber}\n\n` +
            `Your order is on the way!\n\n` +
            `Estimated arrival: 20-30 minutes`,
        'completed': 
            `✅ *Order Completed* #${orderNumber}\n\n` +
            `Thank you for your order! 🙏\n\n` +
            `We hope you enjoyed your meal.\n` +
            `See you again soon!`,
        'cancelled': 
            `❌ *Order Cancelled* #${orderNumber}\n\n` +
            `Your order has been cancelled.\n\n` +
            `If you have questions, please call us.`
    };
    
    return messages[status] || `Order #${orderNumber} status: ${status}`;
}

// ============================================
// LEGACY ENDPOINT - EXISTING SYSTEM
// ============================================
app.post('/api/restaurants/:restaurantId/orders', async (req, res) => {
    try {
        const { restaurantId } = req.params;
        const { customer_name, phone_number, order_type, items: orderItems, notes } = req.body;
        
        if (!customer_name || !phone_number || !orderItems || orderItems.length === 0) {
            return res.status(400).json({ 
                error: 'Missing required fields: customer_name, phone_number, items' 
            });
        }
        
        // Get restaurant settings for tax rate
        const { data: restaurant, error: restError } = await supabase
            .from('restaurants')
            .select('settings, name')
            .eq('id', restaurantId)
            .single();
        
        if (restError) throw restError;
        
        const taxRate = restaurant.settings.tax_rate || 0;
        const restaurantName = restaurant.name || 'Restaurant';
        
        // Fetch actual prices from database (prevent price manipulation)
        const itemIds = orderItems.map(item => item.id);
        const { data: menuItems, error: itemsError } = await supabase
            .from('menu_items')
            .select('id, name, price, is_available')
            .eq('restaurant_id', restaurantId)
            .in('id', itemIds);
        
        if (itemsError) throw itemsError;
        
        // Check if any items are unavailable
        const unavailableItems = menuItems.filter(item => !item.is_available);
        if (unavailableItems.length > 0) {
            return res.status(400).json({ 
                error: 'Some items are currently unavailable',
                unavailable: unavailableItems.map(i => i.name)
            });
        }
        
        // Calculate order total using SERVER prices
        let subtotal = 0;
        const calculatedItems = orderItems.map(orderItem => {
            const menuItem = menuItems.find(m => m.id === orderItem.id);
            if (!menuItem) {
                throw new Error(`Item ${orderItem.id} not found`);
            }
            
            const quantity = parseInt(orderItem.quantity) || 1;
            const itemTotal = menuItem.price * quantity;
            subtotal += itemTotal;
            
            return {
                id: menuItem.id,
                name: menuItem.name,
                price: menuItem.price,
                quantity: quantity,
                item_total: itemTotal
            };
        });
        
        const tax = subtotal * taxRate;
        const total = subtotal + tax;
        
        // Generate order number
        const orderNumber = "UD" + Math.floor(1000 + Math.random() * 9000);
        //const orderId = uuidv4();
        
        // Save order to database
        const { data: savedOrder, error: dbError } = await supabase
            .from('orders')
            .insert([{
                //id: orderId,
                restaurant_id: restaurantId,
                order_number: orderNumber,
                customer_name: customer_name,
                phone_number: phone_number,
                order_source: order_type?.toLowerCase() || 'walk-in',
                order_items: JSON.stringify(calculatedItems),
                total_amount: total.toFixed(2),
                user_input: notes || '',
                status: 'new'
            }])
            .select()
            .single();
        
        if (dbError) throw dbError;
        
        console.log(`✅ Order created: ${orderNumber} - $${total.toFixed(2)}`);
        
        // ============================================
        // FIX 1: SEND IMMEDIATE WHATSAPP CONFIRMATION
        // ============================================
        if (process.env.META_PHONE_ID && process.env.META_ACCESS_TOKEN) {
            const confirmationMessage = `✅ *Order Confirmed!*\n\n` +
                `🏪 ${restaurantName}\n` +
                `📋 Order #${orderNumber}\n\n` +
                `*Your Order:*\n` +
                calculatedItems.map(item => 
                    `• ${item.name} x${item.quantity} - $${item.item_total.toFixed(2)}`
                ).join('\n') +
                `\n\n💰 *Total: $${total.toFixed(2)}*\n\n` +
                `Thank you! We'll send you updates as your order is prepared.\n\n` +
                `📱 You can contact us if you have any questions.`;
            
            // Send WhatsApp asynchronously (don't wait)
            sendWhatsAppMessage(phone_number, confirmationMessage)
                .then(result => {
                    if (result.success) {
                        console.log(`✅ WhatsApp confirmation sent to ${phone_number}`);
                    } else {
                        console.error(`❌ WhatsApp failed: ${result.error}`);
                    }
                })
                .catch(err => {
                    console.error(`❌ WhatsApp error:`, err);
                });
        } else {
            console.warn('⚠️ WhatsApp not configured (missing META_PHONE_ID or META_ACCESS_TOKEN)');
        }
        
        // ============================================
        // FIX 2: BROADCAST TO KDS WITH FULL DETAILS
        // ============================================
        io.emit('new-kds-order', {
            id: orderId,
            orderNumber: orderNumber,
            customerName: customer_name,
            phone: phone_number,
            orderType: order_type || 'Walk-in',
            items: calculatedItems,
            subtotal: subtotal.toFixed(2),
            tax: tax.toFixed(2),
            total: total.toFixed(2),
            status: 'new',
            timestamp: new Date().toISOString(),
            notes: notes || ''
        });
        
        console.log(`📡 KDS broadcast sent for order ${orderNumber}`);
        
        // Also log connected KDS clients
        console.log(`📺 Connected KDS displays: ${io.engine.clientsCount}`);
        
        // Return response to client
        res.json({
            success: true,
            order: {
                id: orderId,
                order_number: orderNumber,
                items: calculatedItems,
                subtotal: subtotal.toFixed(2),
                tax: tax.toFixed(2),
                total: total.toFixed(2),
                tax_rate: (taxRate * 100).toFixed(1) + '%'
            }
        });
        
    } catch (err) {
        console.error('Create order error:', err);
        res.status(500).json({ error: err.message || 'Failed to create order' });
    }
});


// ============================================
// MULTI-TENANT RESTAURANT APIS
// ============================================

// 1. GET RESTAURANT INFO
app.get('/api/restaurants/:slug', async (req, res) => {
    try {
        const { slug } = req.params;
        
        const { data, error } = await supabase
            .from('restaurants')
            .select('*')
            .eq('slug', slug)
            .eq('is_active', true)
            .single();
        
        if (error || !data) {
            return res.status(404).json({ error: 'Restaurant not found' });
        }
        
        res.json({ success: true, restaurant: data });
        
    } catch (err) {
        console.error('Get restaurant error:', err);
        res.status(500).json({ error: 'Failed to get restaurant' });
    }
});

// 2. GET FULL MENU (with categories)
app.get('/api/restaurants/:restaurantId/menu', async (req, res) => {
    try {
        const { restaurantId } = req.params;
        const { available_only } = req.query;
        
        // Get categories
        const { data: categories, error: catError } = await supabase
            .from('menu_categories')
            .select('*')
            .eq('restaurant_id', restaurantId)
            .eq('is_active', true)
            .order('display_order');
        
        if (catError) throw catError;
        
        // Get menu items
        let itemsQuery = supabase
            .from('menu_items')
            .select('*')
            .eq('restaurant_id', restaurantId)
            .order('display_order');
        
        if (available_only === 'true') {
            itemsQuery = itemsQuery.eq('is_available', true);
        }
        
        const { data: items, error: itemsError } = await itemsQuery;
        
        if (itemsError) throw itemsError;
        
        // Group items by category
        const menu = categories.map(category => ({
            ...category,
            items: items.filter(item => item.category_id === category.id)
        }));
        
        res.json({ 
            success: true, 
            menu: menu,
            stats: {
                total_categories: categories.length,
                total_items: items.length,
                available_items: items.filter(i => i.is_available).length
            }
        });
        
    } catch (err) {
        console.error('Get menu error:', err);
        res.status(500).json({ error: 'Failed to get menu' });
    }
});

// 3. GET SINGLE MENU ITEM
app.get('/api/restaurants/:restaurantId/menu/:itemId', async (req, res) => {
    try {
        const { restaurantId, itemId } = req.params;
        
        const { data, error } = await supabase
            .from('menu_items')
            .select(`
                *,
                category:menu_categories(name)
            `)
            .eq('id', itemId)
            .eq('restaurant_id', restaurantId)
            .single();
        
        if (error || !data) {
            return res.status(404).json({ error: 'Item not found' });
        }
        
        res.json({ success: true, item: data });
        
    } catch (err) {
        console.error('Get item error:', err);
        res.status(500).json({ error: 'Failed to get item' });
    }
});

// 4. TOGGLE ITEM AVAILABILITY (Out of Stock)
app.patch('/api/restaurants/:restaurantId/menu/:itemId/availability', async (req, res) => {
    try {
        const { restaurantId, itemId } = req.params;
        const { is_available } = req.body;
        
        if (typeof is_available !== 'boolean') {
            return res.status(400).json({ error: 'is_available must be boolean' });
        }
        
        const { data, error } = await supabase
            .from('menu_items')
            .update({ 
                is_available: is_available,
                updated_at: new Date().toISOString()
            })
            .eq('id', itemId)
            .eq('restaurant_id', restaurantId)
            .select()
            .single();
        
        if (error) throw error;
        
        console.log(`📦 Item ${data.name} availability: ${is_available ? 'IN STOCK' : 'OUT OF STOCK'}`);
        
        res.json({ 
            success: true, 
            item: data,
            message: `Item ${is_available ? 'marked as available' : 'marked as out of stock'}`
        });
        
    } catch (err) {
        console.error('Toggle availability error:', err);
        res.status(500).json({ error: 'Failed to update availability' });
    }
});

// 5. UPDATE MENU ITEM
app.put('/api/restaurants/:restaurantId/menu/:itemId', async (req, res) => {
    try {
        const { restaurantId, itemId } = req.params;
        const { name, description, price, image_url, is_available, category_id } = req.body;
        
        const updates = {
            updated_at: new Date().toISOString()
        };
        
        if (name !== undefined) updates.name = name;
        if (description !== undefined) updates.description = description;
        if (price !== undefined) {
            const parsedPrice = parseFloat(price);
            if (isNaN(parsedPrice) || parsedPrice < 0) {
                return res.status(400).json({ error: 'Invalid price' });
            }
            updates.price = parsedPrice;
        }
        if (image_url !== undefined) updates.image_url = image_url;
        if (is_available !== undefined) updates.is_available = is_available;
        if (category_id !== undefined) updates.category_id = category_id;
        
        const { data, error } = await supabase
            .from('menu_items')
            .update(updates)
            .eq('id', itemId)
            .eq('restaurant_id', restaurantId)
            .select()
            .single();
        
        if (error) throw error;
        
        console.log(`✅ Menu item updated: ${data.name}`);
        
        res.json({ success: true, item: data });
        
    } catch (err) {
        console.error('Update item error:', err);
        res.status(500).json({ error: 'Failed to update item' });
    }
});

// 6. CREATE ORDER WITH SERVER-SIDE CALCULATIONS
app.post('/api/restaurants/:restaurantId/orders', async (req, res) => {
    try {
        const { restaurantId } = req.params;
        const { customer_name, phone_number, order_type, items: orderItems, notes } = req.body;
        
        if (!customer_name || !phone_number || !orderItems || orderItems.length === 0) {
            return res.status(400).json({ 
                error: 'Missing required fields: customer_name, phone_number, items' 
            });
        }
        
        // Get restaurant settings for tax rate
        const { data: restaurant, error: restError } = await supabase
            .from('restaurants')
            .select('settings')
            .eq('id', restaurantId)
            .single();
        
        if (restError) throw restError;
        
        const taxRate = restaurant.settings.tax_rate || 0;
        
        // Fetch actual prices from database (prevent price manipulation)
        const itemIds = orderItems.map(item => item.id);
        const { data: menuItems, error: itemsError } = await supabase
            .from('menu_items')
            .select('id, name, price, is_available')
            .eq('restaurant_id', restaurantId)
            .in('id', itemIds);
        
        if (itemsError) throw itemsError;
        
        // Check if any items are unavailable
        const unavailableItems = menuItems.filter(item => !item.is_available);
        if (unavailableItems.length > 0) {
            return res.status(400).json({ 
                error: 'Some items are currently unavailable',
                unavailable: unavailableItems.map(i => i.name)
            });
        }
        
        // Calculate order total using SERVER prices
        let subtotal = 0;
        const calculatedItems = orderItems.map(orderItem => {
            const menuItem = menuItems.find(m => m.id === orderItem.id);
            if (!menuItem) {
                throw new Error(`Item ${orderItem.id} not found`);
            }
            
            const quantity = parseInt(orderItem.quantity) || 1;
            const itemTotal = menuItem.price * quantity;
            subtotal += itemTotal;
            
            return {
                id: menuItem.id,
                name: menuItem.name,
                price: menuItem.price,
                quantity: quantity,
                item_total: itemTotal
            };
        });
        
        const tax = subtotal * taxRate;
        const total = subtotal + tax;
        
        // Generate order number
        const orderNumber = "UD" + Math.floor(1000 + Math.random() * 9000);
        const orderId = uuidv4();
        
        // Save order to database
        const { data: savedOrder, error: dbError } = await supabase
            .from('orders')
            .insert([{
                id: orderId,
                restaurant_id: restaurantId,
                order_number: orderNumber,
                customer_name: customer_name,
                phone_number: phone_number,
                order_source: order_type?.toLowerCase() || 'walk-in',
                order_items: JSON.stringify(calculatedItems),
                total_amount: total.toFixed(2),
                user_input: notes || '',
                status: 'new'
            }])
            .select()
            .single();
        
        if (dbError) throw dbError;
        
        console.log(`✅ Order created: ${orderNumber} - $${total.toFixed(2)}`);
        
        // Broadcast to KDS
        io.emit('new-kds-order', {
            id: orderId,
            orderNumber: orderNumber,
            customerName: customer_name,
            orderType: order_type,
            items: calculatedItems,
            subtotal: subtotal.toFixed(2),
            tax: tax.toFixed(2),
            total: total.toFixed(2)
        });
        
        res.json({
            success: true,
            order: {
                id: orderId,
                order_number: orderNumber,
                items: calculatedItems,
                subtotal: subtotal.toFixed(2),
                tax: tax.toFixed(2),
                total: total.toFixed(2),
                tax_rate: (taxRate * 100).toFixed(1) + '%'
            }
        });
        
    } catch (err) {
        console.error('Create order error:', err);
        res.status(500).json({ error: err.message || 'Failed to create order' });
    }
});

// 7. BULK UPDATE AVAILABILITY
app.post('/api/restaurants/:restaurantId/menu/bulk-availability', async (req, res) => {
    try {
        const { restaurantId } = req.params;
        const { item_ids, is_available } = req.body;
        
        if (!Array.isArray(item_ids) || typeof is_available !== 'boolean') {
            return res.status(400).json({ 
                error: 'Invalid request. Need item_ids array and is_available boolean' 
            });
        }
        
        const { data, error } = await supabase
            .from('menu_items')
            .update({ 
                is_available: is_available,
                updated_at: new Date().toISOString()
            })
            .eq('restaurant_id', restaurantId)
            .in('id', item_ids)
            .select();
        
        if (error) throw error;
        
        console.log(`📦 Bulk update: ${data.length} items marked as ${is_available ? 'available' : 'unavailable'}`);
        
        res.json({ 
            success: true, 
            updated_count: data.length,
            items: data
        });
        
    } catch (err) {
        console.error('Bulk update error:', err);
        res.status(500).json({ error: 'Failed to bulk update' });
    }
});

// 8. GET ORDER DETAILS
app.get('/api/restaurants/:restaurantId/orders/:orderId', async (req, res) => {
    try {
        const { restaurantId, orderId } = req.params;
        
        const { data, error } = await supabase
            .from('orders')
            .select('*')
            .eq('id', orderId)
            .eq('restaurant_id', restaurantId)
            .single();
        
        if (error || !data) {
            return res.status(404).json({ error: 'Order not found' });
        }
        
        res.json({ success: true, order: data });
        
    } catch (err) {
        console.error('Get order error:', err);
        res.status(500).json({ error: 'Failed to get order' });
    }
});

// 9. SEARCH MENU ITEMS
app.get('/api/restaurants/:restaurantId/menu/search', async (req, res) => {
    try {
        const { restaurantId } = req.params;
        const { q } = req.query;
        
        if (!q || q.trim().length < 2) {
            return res.status(400).json({ error: 'Search query must be at least 2 characters' });
        }
        
        const { data, error } = await supabase
            .from('menu_items')
            .select(`
                *,
                category:menu_categories(name)
            `)
            .eq('restaurant_id', restaurantId)
            .ilike('name', `%${q}%`);
        
        if (error) throw error;
        
        res.json({ 
            success: true, 
            results: data,
            count: data.length
        });
        
    } catch (err) {
        console.error('Search error:', err);
        res.status(500).json({ error: 'Search failed' });
    }
});

// 10. GET RESTAURANT STATISTICS
app.get('/api/restaurants/:restaurantId/stats', async (req, res) => {
    try {
        const { restaurantId } = req.params;
        
        const { data: menuItems } = await supabase
            .from('menu_items')
            .select('is_available')
            .eq('restaurant_id', restaurantId);
        
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        
        const { data: todayOrders } = await supabase
            .from('orders')
            .select('total_amount, status')
            .eq('restaurant_id', restaurantId)
            .gte('created_at', today.toISOString());
        
        const stats = {
            menu: {
                total_items: menuItems?.length || 0,
                available: menuItems?.filter(i => i.is_available).length || 0,
                out_of_stock: menuItems?.filter(i => !i.is_available).length || 0
            },
            orders_today: {
                count: todayOrders?.length || 0,
                revenue: todayOrders?.reduce((sum, o) => sum + parseFloat(o.total_amount), 0).toFixed(2) || '0.00',
                by_status: {
                    new: todayOrders?.filter(o => o.status === 'new').length || 0,
                    confirmed: todayOrders?.filter(o => o.status === 'confirmed').length || 0,
                    preparing: todayOrders?.filter(o => o.status === 'preparing').length || 0,
                    ready: todayOrders?.filter(o => o.status === 'ready').length || 0,
                    completed: todayOrders?.filter(o => o.status === 'completed').length || 0
                }
            }
        };
        
        res.json({ success: true, stats });
        
    } catch (err) {
        console.error('Stats error:', err);
        res.status(500).json({ error: 'Failed to get stats' });
    }
});

// ============================================
// ORDER STATUS UPDATE LISTENER
// ============================================
if (supabase) {
    console.log('📡 Setting up order status listener...');
    
    supabase
        .channel('order_status_updates')
        .on(
            'postgres_changes',
            {
                event: 'UPDATE',
                schema: 'public',
                table: 'orders'
            },
            async (payload) => {
                const order = payload.new;
                const oldOrder = payload.old;
                
                if (order.status !== oldOrder.status) {
                    console.log(`📦 Order ${order.order_number} status: ${oldOrder.status} → ${order.status}`);
                    
                    const customerPhone = order.phone_number;
                    const orderNumber = order.order_number;
                    const newStatus = order.status;
                    
                    const statusMessage = getStatusMessage(newStatus, orderNumber);
                    
                    // Send WhatsApp notification
                    if (process.env.META_PHONE_ID && process.env.META_ACCESS_TOKEN) {
                        await sendWhatsAppMessage(customerPhone, statusMessage);
                    }
                    
                    // Broadcast to KDS
                    io.emit('order_status_update', {
                        id: order.id,
                        orderNumber: orderNumber,
                        status: newStatus,
                        timestamp: new Date().toISOString()
                    });
                }
            }
        )
        .subscribe((status) => {
            if (status === 'SUBSCRIBED') {
                console.log('✅ Order status listener active');
            }
        });
}

// ============================================
// START SERVER
// ============================================
server.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Server running on port ${PORT}`);
});