#!/usr/bin/env python3
"""
Fixed test with proper event handler setup
"""

import socketio
import asyncio
import logging

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

BASE_URL = "https://translate-match-1.preview.emergentagent.com"

async def test_working_messages():
    """Test with properly set up event handlers"""
    try:
        client1_events = []
        client2_events = []
        room_id = None
        
        # Create clients
        sio1 = socketio.AsyncClient(logger=False, engineio_logger=False)
        sio2 = socketio.AsyncClient(logger=False, engineio_logger=False)
        
        # Set up event handlers BEFORE connecting
        @sio1.event
        async def connect():
            client1_events.append("connected")
            logger.info("Client 1 connected")
        
        @sio1.event
        async def matched(data):
            nonlocal room_id
            room_id = data.get('roomId')
            client1_events.append(("matched", data))
            logger.info(f"Client 1 matched: {data}")
        
        @sio1.event
        async def receive_message(data):
            client1_events.append(("receive_message", data))
            logger.info(f"Client 1 received message: {data}")
        
        @sio1.event
        async def partner_left():
            client1_events.append("partner_left")
            logger.info("Client 1 received partner-left event")
        
        @sio2.event
        async def connect():
            client2_events.append("connected")
            logger.info("Client 2 connected")
        
        @sio2.event
        async def matched(data):
            client2_events.append(("matched", data))
            logger.info(f"Client 2 matched: {data}")
        
        @sio2.event
        async def receive_message(data):
            client2_events.append(("receive_message", data))
            logger.info(f"Client 2 received message: {data}")
        
        @sio2.event
        async def partner_left():
            client2_events.append("partner_left")
            logger.info("Client 2 received partner-left event")
        
        # Now connect
        logger.info("=== Connecting clients ===")
        await sio1.connect(BASE_URL, transports=['websocket', 'polling'])
        await asyncio.sleep(1)
        
        await sio1.emit('join-queue', {
            'primaryLanguage': {'code': 'zh-CN', 'name': 'Chinese'},
            'spokenLanguages': [],
            'mode': 'video'
        })
        await asyncio.sleep(1)
        
        await sio2.connect(BASE_URL, transports=['websocket', 'polling'])
        await asyncio.sleep(1)
        
        await sio2.emit('join-queue', {
            'primaryLanguage': {'code': 'ar-SA', 'name': 'Arabic'},
            'spokenLanguages': [],
            'mode': 'video'
        })
        await asyncio.sleep(2)  # Wait for matching
        
        logger.info(f"Room ID: {room_id}")
        if room_id:
            logger.info("=== Testing message exchange ===")
            
            # Client 1 sends message
            await sio1.emit('send-message', {
                'roomId': room_id,
                'message': 'Hello from Chinese speaker!',
                'fromLang': 'zh'
            })
            await asyncio.sleep(2)
            
            # Client 2 sends reply
            await sio2.emit('send-message', {
                'roomId': room_id,
                'message': 'Hello from Arabic speaker!',
                'fromLang': 'ar'
            })
            await asyncio.sleep(2)
            
            logger.info("=== Testing next/leave ===")
            await sio1.emit('next')
            await asyncio.sleep(2)
            
            logger.info(f"Client 1 final events: {client1_events}")
            logger.info(f"Client 2 final events: {client2_events}")
            
            # Check results
            client1_got_message = any(event[0] == 'receive_message' for event in client1_events if isinstance(event, tuple))
            client2_got_message = any(event[0] == 'receive_message' for event in client2_events if isinstance(event, tuple))
            client2_got_partner_left = 'partner_left' in client2_events
            
            logger.info(f"✅ Client 1 got message: {client1_got_message}")
            logger.info(f"✅ Client 2 got message: {client2_got_message}")
            logger.info(f"✅ Client 2 got partner-left: {client2_got_partner_left}")
            
            if client1_got_message and client2_got_message and client2_got_partner_left:
                logger.info("🎉 ALL TESTS PASSED!")
            else:
                logger.warning("⚠️ Some tests failed")
        
        await sio1.disconnect()
        await sio2.disconnect()
        
    except Exception as e:
        logger.error(f"Test failed: {str(e)}")

if __name__ == "__main__":
    asyncio.run(test_working_messages())