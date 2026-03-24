#!/usr/bin/env python3
"""
Simple Socket.io test to isolate the issue
"""

import socketio
import asyncio
import json
import logging

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

BASE_URL = "https://translate-match-1.preview.emergentagent.com"

async def simple_matchmaking_test():
    """Simple matchmaking test"""
    try:
        # Create clients with unique identifiers
        sio1 = socketio.AsyncClient(logger=False, engineio_logger=False)
        sio2 = socketio.AsyncClient(logger=False, engineio_logger=False) 
        
        events1 = []
        events2 = []
        
        # Client 1 events
        @sio1.event
        async def connect():
            events1.append("connected")
            logger.info("Client 1 connected")
        
        @sio1.event
        async def matched(data):
            events1.append(("matched", data))
            logger.info(f"Client 1 matched: {data}")
        
        @sio1.event
        async def queue_status(data):
            events1.append(("queue_status", data))
            logger.info(f"Client 1 queue: {data}")
        
        # Client 2 events
        @sio2.event
        async def connect():
            events2.append("connected")
            logger.info("Client 2 connected")
        
        @sio2.event
        async def matched(data):
            events2.append(("matched", data))
            logger.info(f"Client 2 matched: {data}")
        
        @sio2.event
        async def queue_status(data):
            events2.append(("queue_status", data))
            logger.info(f"Client 2 queue: {data}")
        
        # Connect client 1
        logger.info("=== Step 1: Connecting Client 1 ===")
        await sio1.connect(BASE_URL, transports=['websocket', 'polling'])
        await asyncio.sleep(1)
        
        # Client 1 joins queue
        logger.info("=== Step 2: Client 1 joins queue ===")
        queue_data_1 = {
            'primaryLanguage': {
                'code': 'en-US',
                'name': 'English'
            },
            'spokenLanguages': [],
            'mode': 'video'
        }
        await sio1.emit('join-queue', queue_data_1)
        await asyncio.sleep(1)
        
        logger.info(f"Client 1 events: {events1}")
        
        # Connect client 2
        logger.info("=== Step 3: Connecting Client 2 ===")
        await sio2.connect(BASE_URL, transports=['websocket', 'polling'])
        await asyncio.sleep(1)
        
        # Client 2 joins queue (should trigger match)
        logger.info("=== Step 4: Client 2 joins queue (should match) ===")
        queue_data_2 = {
            'primaryLanguage': {
                'code': 'fr-FR',  # Different language to avoid confusion
                'name': 'French'
            },
            'spokenLanguages': [],
            'mode': 'video'
        }
        await sio2.emit('join-queue', queue_data_2)
        await asyncio.sleep(3)  # Wait for matching
        
        logger.info(f"Final Client 1 events: {events1}")
        logger.info(f"Final Client 2 events: {events2}")
        
        # Check results
        client1_matched = any(event[0] == 'matched' for event in events1 if isinstance(event, tuple))
        client2_matched = any(event[0] == 'matched' for event in events2 if isinstance(event, tuple))
        
        logger.info(f"Client 1 matched: {client1_matched}")
        logger.info(f"Client 2 matched: {client2_matched}")
        
        if client1_matched and client2_matched:
            logger.info("✅ BOTH CLIENTS MATCHED SUCCESSFULLY!")
            
            # Extract match data
            match1 = next(event[1] for event in events1 if isinstance(event, tuple) and event[0] == 'matched')
            match2 = next(event[1] for event in events2 if isinstance(event, tuple) and event[0] == 'matched')
            
            logger.info(f"Match 1 data: {match1}")
            logger.info(f"Match 2 data: {match2}")
            
            # Verify room consistency
            if match1.get('roomId') == match2.get('roomId'):
                logger.info("✅ ROOM IDs MATCH")
            else:
                logger.error("❌ ROOM IDs DON'T MATCH")
                
        else:
            logger.error(f"❌ MATCHING FAILED - Client1: {client1_matched}, Client2: {client2_matched}")
            
        await sio1.disconnect()
        await sio2.disconnect()
        
    except Exception as e:
        logger.error(f"Test failed: {str(e)}")

if __name__ == "__main__":
    asyncio.run(simple_matchmaking_test())