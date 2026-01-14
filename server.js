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
// NEW: GET ITEM CUSTOMIZATIONS
// ============================================
app.get('/api/menu-items/:itemId/customizations', async (req, res) => {
    try {
        const { itemId } = req.params;
        
        // Get customization categories
        const { data: categories, error: catError } = await supabase
            .from('item_customization_categories')
            .select('*')
            .eq('menu_item_id', itemId)
            .order('display_order');
        
        if (catError) throw catError;
        
        if (!categories || categories.length === 0) {
            return res.json({ 
                success: true, 
                customizations: [] 
            });
        }
        
        // Get options for each category
        const categoryIds = categories.map(c => c.id);
        const { data: options, error: optError } = await supabase
            .from('customization_options')
            .select('*')
            .in('category_id', categoryIds)
            .eq('is_available', true)
            .order('display_order');
        
        if (optError) throw optError;
        
        // Group options by category
        const customizations = categories.map(category => ({
            ...category,
            options: options.filter(opt => opt.category_id === category.id)
        }));
        
        res.json({ 
            success: true, 
            customizations 
        });
        
    } catch (err) {
        console.error('Get customizations error:', err);
        res.status(500).json({ error: 'Failed to get customizations' });
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

// ============================================
// UPDATED: CREATE ORDER WITH CUSTOMIZATIONS
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
        
        // Calculate total with customizations
        let subtotal = 0;
        const calculatedItems = [];
        
        for (const orderItem of orderItems) {
            const menuItem = menuItems.find(m => m.id === orderItem.id);
            if (!menuItem) {
                throw new Error(`Item ${orderItem.id} not found`);
            }
            
            const quantity = parseInt(orderItem.quantity) || 1;
            let itemPrice = menuItem.price;
            
            // Add customization prices
            let customizationsTotal = 0;
            const customizationDetails = [];
            
            if (orderItem.customizations && orderItem.customizations.length > 0) {
                const customizationIds = orderItem.customizations.map(c => c.id);
                
                const { data: customOptions } = await supabase
                    .from('customization_options')
                    .select('id, name, price')
                    .in('id', customizationIds);
                
                if (customOptions) {
                    customOptions.forEach(opt => {
                        customizationsTotal += parseFloat(opt.price);
                        customizationDetails.push({
                            id: opt.id,
                            name: opt.name,
                            price: parseFloat(opt.price)
                        });
                    });
                }
            }
            
            const itemTotal = (itemPrice + customizationsTotal) * quantity;
            subtotal += itemTotal;
            
            calculatedItems.push({
                id: menuItem.id,
                name: menuItem.name,
                price: menuItem.price,
                quantity: quantity,
                customizations: customizationDetails,
                special_notes: orderItem.special_notes || '',
                item_total: itemTotal
            });
        }
        
        const tax = subtotal * taxRate;
        const total = subtotal + tax;
        
        const orderNumber = "UD" + Math.floor(1000 + Math.random() * 9000);
        const orderId = uuidv4();
        
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
        
        // Send WhatsApp confirmation
        if (process.env.META_PHONE_ID && process.env.META_ACCESS_TOKEN) {
            const itemsText = calculatedItems.map(item => {
                let itemStr = `• ${item.name} x${item.quantity}`;
                if (item.customizations && item.customizations.length > 0) {
                    const customText = item.customizations.map(c => c.name).join(', ');
                    itemStr += `\n  + ${customText}`;
                }
                itemStr += ` - $${item.item_total.toFixed(2)}`;
                return itemStr;
            }).join('\n');
            
            const confirmationMessage = `✅ *Order Confirmed!*\n\n` +
                `🏪 ${restaurantName}\n` +
                `📋 Order #${orderNumber}\n\n` +
                `*Your Order:*\n` +
                itemsText +
                `\n\n💰 *Total: $${total.toFixed(2)}*\n\n` +
                `Thank you! We'll send you updates as your order is prepared.`;
            
            sendWhatsAppMessage(phone_number, confirmationMessage);
        }
        
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
        console.log(`Payload sent to KDS: ${calculatedItems}`),
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
// 4. UPDATE ORDER STATUS (with WhatsApp notifications)
// ============================================
app.put('/api/orders/:orderId/status', async (req, res) => {
    const { orderId } = req.params;
    const { status } = req.body;
    
    try {
        // Get current order details BEFORE updating
        const { data: currentOrder, error: fetchError } = await supabase
            .from('orders')
            .select('*')
            .eq('id', orderId)
            .single();
        
        if (fetchError) {
            return res.status(500).json({ success: false, error: fetchError.message });
        }
        // Update in database
        const { data, error } = await supabase
            .from('orders')
            .update({ 
                status,
                updated_at: new Date().toISOString()
            })
            .eq('id', orderId)
            .select()
            .single();
        
        if (error) {
            return res.status(500).json({ success: false, error: error.message });
        }
        
        console.log(`📝 Order ${data.order_number} status: ${currentOrder.status} → ${status}`);
        // Send WhatsApp notifications for status changes
        if (process.env.META_PHONE_ID && process.env.META_ACCESS_TOKEN && currentOrder.phone_number) {
            let message = '';
            let shouldSend = false;
            
            if (status === 'preparing' && currentOrder.status === 'new') {
                message = `👨‍🍳 *Order Update*\n\n` +
                    `Order #${data.order_number}\n\n` +
                    `Your order is now being prepared! 🔥`;
                shouldSend = true;
            } 
            else if (status === 'ready' && currentOrder.status === 'preparing') {
                message = `✅ *Order Ready!*\n\n` +
                    `Order #${data.order_number}\n\n` +
                    `Your order is ready for pickup! 🎉`;
                shouldSend = true;
            }
            else if (status === 'completed' && currentOrder.status === 'ready') {
                message = `🎊 *Order Completed*\n\n` +
                    `Order #${data.order_number}\n\n` +
                    `Thank you for your order! 😊`;
                shouldSend = true;
            }
            
            if (shouldSend) {
                console.log(`📱 Sending WhatsApp update to ${currentOrder.phone_number}`);
                sendWhatsAppMessage(currentOrder.phone_number, message);
                

            }
        }
        // Broadcast to other KDS displays
        io.emit('order_updated', {
            orderId: orderId,
            status: status
        });
        
        res.json({ success: true, order: data });
        
    } catch (err) {
        console.error('Update status error:', err);
        res.status(500).json({ error: err.message || 'Failed to update status' });
    }
});
// ============================================
// GET ALL ORDERS FOR A SPECIFIC RESTAURANT (for KDS)
// ============================================
app.get('/api/restaurants/:restaurantId/orders', async (req, res) => {
    try {
        const { restaurantId } = req.params;
        const { status } = req.query;
         console.log(`📋 Fetching orders for restaurant: ${restaurantId}`);        
        let query = supabase
            .from('orders')
            .select('*')
            .eq('restaurant_id', restaurantId)
            .order('created_at', { ascending: false });
        // Filter by status if provided (?status=new,preparing,ready)
        if (status) {
            const statusArray = status.split(',').map(s => s.trim());
            query = query.in('status', statusArray);
            console.log(`📋 Filtering by status: ${statusArray.join(', ')}`);
        }
        
        const { data, error } = await query;
        
        if (error) {
            console.error('❌ Fetch orders error:', error);
            throw error;
        }
        
        console.log(`✅ Found ${data.length} orders for restaurant ${restaurantId}`);        
        res.json({ 
            success: true, 
            orders: data,
            count: data.length 
        });
        
    } catch (err) {
        console.error('Get restaurant orders error:', err);
        res.status(500).json({ 
            success: false,
            error: 'Failed to get orders' 
        });
    }
});
// ============================================
// 5. GET ORDER DETAILS
// ============================================
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
// ============================================
// 6. GET ALL ORDERS (for KDS)
// ============================================
app.get('/api/orders', async (req, res) => {
    try {
        const { status } = req.query;
        
        let query = supabase
            .from('orders')
            .select('*')
            .order('created_at', { ascending: false });
        
        if (status) {
            const statusArray = status.split(',');
            query = query.in('status', statusArray);
        }
        
        const { data, error } = await query;
        
        if (error) throw error;
        
        res.json({ success: true, orders: data });
        
    } catch (err) {
        console.error('Get orders error:', err);
        res.status(500).json({ error: 'Failed to get orders' });
    }
});
// ============================================
// 7. GET RESTAURANT STATISTICS
// ============================================
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
// SOCKET.IO CONNECTIONS
// ============================================
io.on('connection', (socket) => {
    console.log(`✅ KDS connected: ${socket.id}`);
    
    socket.on('disconnect', () => {
        console.log(`❌ KDS disconnected: ${socket.id}`);
        console.log(`📺 Total connections: ${io.engine.clientsCount}`);
    });
});
// ============================================
// START SERVER
// ============================================
server.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Server running on port ${PORT}`);
    console.log(`📡 Socket.IO ready`);
    console.log(`🔗 WhatsApp ${process.env.META_PHONE_ID ? 'enabled' : 'disabled'}`);
});