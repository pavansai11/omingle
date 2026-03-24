#!/usr/bin/env python3
"""
Debug message passing specifically
"""

import socketio
import asyncio
import logging

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

BASE_URL = "https://translate-match-1.preview.emergentagent.com"

async def debug_message_passing():
    """Debug message passing specifically"""
    try:
        sio1 = socketio.AsyncClient(logger=False, engineio_logger=False)
        sio2 = socketio.AsyncClient(logger=False, engineio_logger=False)
        
        client1_events = []
        client2_events = []
        room_id = None
        
        # Client 1 events
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
        
        # Client 2 events
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
        
        # Connect and match
        logger.info("=== Step 1: Connecting clients ===")
        await sio1.connect(BASE_URL, transports=['websocket', 'polling'])
        await asyncio.sleep(1)
        
        await sio1.emit('join-queue', {
            'primaryLanguage': {'code': 'ja-JP', 'name': 'Japanese'},
            'spokenLanguages': [],
            'mode': 'video'
        })
        await asyncio.sleep(1)
        
        await sio2.connect(BASE_URL, transports=['websocket', 'polling'])
        await asyncio.sleep(1)
        
        await sio2.emit('join-queue', {
            'primaryLanguage': {'code': 'ko-KR', 'name': 'Korean'},
            'spokenLanguages': [],
            'mode': 'video'
        })
        await asyncio.sleep(2)
        
        logger.info(f"Client 1 events after matching: {client1_events}")
        logger.info(f"Client 2 events after matching: {client2_events}")
        logger.info(f"Room ID: {room_id}")
        
        if room_id:
            logger.info("=== Step 2: Testing message sending ===")
            
            # Test message from client 1 to client 2
            message_data = {
                'roomId': room_id,
                'message': 'Test message from client 1',
                'fromLang': 'ja'
            }
            
            logger.info(f"Client 1 sending message: {message_data}")
            await sio1.emit('send-message', message_data)
            await asyncio.sleep(3)  # Wait longer
            
            logger.info(f"Client 1 events after message: {client1_events}")
            logger.info(f"Client 2 events after message: {client2_events}")
            
            # Test message from client 2 to client 1
            message_data2 = {
                'roomId': room_id,
                'message': 'Reply from client 2',
                'fromLang': 'ko'
            }
            
            logger.info(f"Client 2 sending reply: {message_data2}")
            await sio2.emit('send-message', message_data2)
            await asyncio.sleep(3)
            
            logger.info(f"Client 1 events after reply: {client1_events}")
            logger.info(f"Client 2 events after reply: {client2_events}")
            
            logger.info("=== Step 3: Testing next/leave ===")
            logger.info("Client 1 emitting 'next'...")
            await sio1.emit('next')
            await asyncio.sleep(3)
            
            logger.info(f"Client 1 final events: {client1_events}")
            logger.info(f"Client 2 final events: {client2_events}")
        
        await sio1.disconnect()
        await sio2.disconnect()
        
    except Exception as e:
        logger.error(f"Debug failed: {str(e)}")

if __name__ == "__main__":
    asyncio.run(debug_message_passing())