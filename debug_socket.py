#!/usr/bin/env python3
"""
Debug Socket.io issues
"""

import socketio
import asyncio
import json
import logging

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

BASE_URL = "https://translate-match-1.preview.emergentagent.com"

async def debug_socketio():
    """Debug Socket.io connection and events"""
    try:
        sio1 = socketio.AsyncClient(logger=True, engineio_logger=True)
        sio2 = socketio.AsyncClient(logger=True, engineio_logger=True)
        
        # Track events
        events1 = []
        events2 = []
        
        @sio1.event
        async def connect():
            logger.info("Client 1 connected")
            events1.append("connected")
        
        @sio1.event
        async def matched(data):
            logger.info(f"Client 1 matched: {data}")
            events1.append(("matched", data))
        
        @sio1.event 
        async def queue_status(data):
            logger.info(f"Client 1 queue status: {data}")
            events1.append(("queue-status", data))
            
        @sio2.event
        async def connect():
            logger.info("Client 2 connected")
            events2.append("connected")
        
        @sio2.event
        async def matched(data):
            logger.info(f"Client 2 matched: {data}")
            events2.append(("matched", data))
            
        @sio2.event 
        async def queue_status(data):
            logger.info(f"Client 2 queue status: {data}")
            events2.append(("queue-status", data))
            
        # Connect first client
        logger.info("Connecting client 1...")
        await sio1.connect(BASE_URL, transports=['websocket', 'polling'])
        await asyncio.sleep(2)
        
        # Join queue with first client
        queue_data = {
            'primaryLanguage': {
                'code': 'en-US',
                'name': 'English', 
                'flag': '🇺🇸',
                'googleCode': 'en',
                'webSpeechCode': 'en-US',
                'nativeName': 'English'
            },
            'spokenLanguages': [],
            'mode': 'video'
        }
        
        logger.info("Client 1 joining queue...")
        await sio1.emit('join-queue', queue_data)
        await asyncio.sleep(2)
        
        logger.info(f"Client 1 events so far: {events1}")
        
        # Connect second client
        logger.info("Connecting client 2...")  
        await sio2.connect(BASE_URL, transports=['websocket', 'polling'])
        await asyncio.sleep(2)
        
        # Join queue with second client
        logger.info("Client 2 joining queue...")
        await sio2.emit('join-queue', queue_data)
        await asyncio.sleep(5)  # Wait longer for matching
        
        logger.info(f"Final events - Client 1: {events1}")
        logger.info(f"Final events - Client 2: {events2}")
        
        await sio1.disconnect()
        await sio2.disconnect()
        
    except Exception as e:
        logger.error(f"Debug failed: {str(e)}")

if __name__ == "__main__":
    asyncio.run(debug_socketio())