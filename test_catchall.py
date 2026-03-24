#!/usr/bin/env python3
"""
Test with catch-all handler to debug
"""

import socketio
import asyncio
import logging

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

BASE_URL = "https://translate-match-1.preview.emergentagent.com"

async def test_catch_all():
    """Test with catch-all event handler"""
    try:
        sio1 = socketio.AsyncClient(logger=False, engineio_logger=False)
        sio2 = socketio.AsyncClient(logger=False, engineio_logger=False)
        
        client1_events = []
        client2_events = []
        room_id = None
        
        # Set up catch-all handlers to see all events
        @sio1.on('*')
        async def catch_all_1(event, *args):
            client1_events.append((event, args))
            logger.info(f"Client 1 caught event '{event}' with args: {args}")
            
        @sio2.on('*')
        async def catch_all_2(event, *args):
            client2_events.append((event, args))
            logger.info(f"Client 2 caught event '{event}' with args: {args}")
            
        # Specific handlers for important events
        @sio1.event
        async def matched(data):
            nonlocal room_id
            room_id = data.get('roomId')
            logger.info(f"Client 1 matched: {data}")
            
        @sio2.event
        async def matched(data):
            logger.info(f"Client 2 matched: {data}")
        
        # Connect clients
        logger.info("=== Connecting clients ===")
        await sio1.connect(BASE_URL, transports=['websocket', 'polling'])
        await asyncio.sleep(1)
        
        await sio1.emit('join-queue', {
            'primaryLanguage': {'code': 'ru-RU', 'name': 'Russian'},
            'spokenLanguages': [],
            'mode': 'video'
        })
        await asyncio.sleep(1)
        
        await sio2.connect(BASE_URL, transports=['websocket', 'polling'])
        await asyncio.sleep(1)
        
        await sio2.emit('join-queue', {
            'primaryLanguage': {'code': 'tr-TR', 'name': 'Turkish'},
            'spokenLanguages': [],
            'mode': 'video'
        })
        await asyncio.sleep(3)
        
        logger.info(f"Room ID: {room_id}")
        if room_id:
            logger.info("=== Sending test messages ===")
            
            await sio1.emit('send-message', {
                'roomId': room_id,
                'message': 'Hello from Russian speaker',
                'fromLang': 'ru'
            })
            await asyncio.sleep(2)
            
            await sio2.emit('send-message', {
                'roomId': room_id,
                'message': 'Hello from Turkish speaker',
                'fromLang': 'tr'
            })
            await asyncio.sleep(2)
            
            logger.info("=== Testing next/leave ===")
            await sio1.emit('next')
            await asyncio.sleep(2)
            
        logger.info(f"Client 1 all events: {client1_events}")
        logger.info(f"Client 2 all events: {client2_events}")
        
        # Check for specific events
        client1_got_receive_message = any(event[0] == 'receive-message' for event in client1_events)
        client2_got_receive_message = any(event[0] == 'receive-message' for event in client2_events)
        client2_got_partner_left = any(event[0] == 'partner-left' for event in client2_events)
        
        logger.info(f"✅ Client 1 got receive-message: {client1_got_receive_message}")
        logger.info(f"✅ Client 2 got receive-message: {client2_got_receive_message}")
        logger.info(f"✅ Client 2 got partner-left: {client2_got_partner_left}")
        
        await sio1.disconnect()
        await sio2.disconnect()
        
    except Exception as e:
        logger.error(f"Test failed: {str(e)}")

if __name__ == "__main__":
    asyncio.run(test_catch_all())