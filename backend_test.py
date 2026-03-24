#!/usr/bin/env python3
"""
Omingle Backend Test Suite
Tests API endpoints and Socket.io functionality
"""

import requests
import socketio
import asyncio
import json
import time
from typing import List, Dict, Any
import logging

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

BASE_URL = "https://translate-match-1.preview.emergentagent.com"

class OmingleTester:
    def __init__(self):
        self.base_url = BASE_URL
        self.api_url = f"{self.base_url}/api"
        self.results = []
        
    def log_result(self, test_name: str, success: bool, message: str, details: Dict = None):
        """Log test result"""
        result = {
            "test": test_name,
            "success": success,
            "message": message,
            "details": details or {}
        }
        self.results.append(result)
        status = "✅ PASS" if success else "❌ FAIL"
        logger.info(f"{status} - {test_name}: {message}")
        
    def test_api_health(self):
        """Test GET /api/health endpoint"""
        try:
            response = requests.get(f"{self.api_url}/health", timeout=10)
            
            if response.status_code == 200:
                data = response.json()
                if data.get("status") == "ok" and "Omingle API running" in data.get("message", ""):
                    self.log_result("API Health Check", True, "Health endpoint working correctly", 
                                  {"response": data, "status_code": response.status_code})
                else:
                    self.log_result("API Health Check", False, f"Unexpected response format: {data}")
            else:
                self.log_result("API Health Check", False, f"HTTP {response.status_code}: {response.text}")
                
        except Exception as e:
            self.log_result("API Health Check", False, f"Request failed: {str(e)}")

    def test_translation_api(self):
        """Test POST /api/translate endpoint"""
        
        # Test 1: Valid translation request
        try:
            payload = {"text": "Hello", "from": "en", "to": "hi"}
            response = requests.post(f"{self.api_url}/translate", json=payload, timeout=10)
            
            if response.status_code == 200:
                data = response.json()
                if "translatedText" in data and data.get("mock") == True:
                    self.log_result("Translation API - Valid Request", True, "Translation endpoint working with mock data", 
                                  {"request": payload, "response": data})
                else:
                    self.log_result("Translation API - Valid Request", False, f"Unexpected response format: {data}")
            else:
                self.log_result("Translation API - Valid Request", False, f"HTTP {response.status_code}: {response.text}")
                
        except Exception as e:
            self.log_result("Translation API - Valid Request", False, f"Request failed: {str(e)}")

        # Test 2: Missing fields (should return 400)
        try:
            payload = {"text": "Hello"}  # Missing from and to
            response = requests.post(f"{self.api_url}/translate", json=payload, timeout=10)
            
            if response.status_code == 400:
                data = response.json()
                if "error" in data and "Missing fields" in data["error"]:
                    self.log_result("Translation API - Missing Fields", True, "Correctly validates missing fields", 
                                  {"request": payload, "response": data})
                else:
                    self.log_result("Translation API - Missing Fields", False, f"Wrong error message: {data}")
            else:
                self.log_result("Translation API - Missing Fields", False, f"Expected 400, got {response.status_code}")
                
        except Exception as e:
            self.log_result("Translation API - Missing Fields", False, f"Request failed: {str(e)}")

        # Test 3: Same from/to languages
        try:
            payload = {"text": "Hello", "from": "en", "to": "en"}
            response = requests.post(f"{self.api_url}/translate", json=payload, timeout=10)
            
            if response.status_code == 200:
                data = response.json()
                if data.get("translatedText") == "Hello" and "mock" not in data:
                    self.log_result("Translation API - Same Language", True, "Correctly handles same source/target language", 
                                  {"request": payload, "response": data})
                else:
                    self.log_result("Translation API - Same Language", False, f"Unexpected response: {data}")
            else:
                self.log_result("Translation API - Same Language", False, f"HTTP {response.status_code}: {response.text}")
                
        except Exception as e:
            self.log_result("Translation API - Same Language", False, f"Request failed: {str(e)}")

    async def test_socketio_connection(self):
        """Test Socket.io connection"""
        try:
            sio = socketio.AsyncClient(logger=False, engineio_logger=False)
            
            connected = False
            
            @sio.event
            async def connect():
                nonlocal connected
                connected = True
                logger.info("Socket.io connected successfully")
            
            @sio.event
            async def disconnect():
                logger.info("Socket.io disconnected")
            
            await sio.connect(self.base_url, transports=['websocket', 'polling'])
            await asyncio.sleep(2)  # Wait for connection to establish
            
            if connected:
                self.log_result("Socket.io Connection", True, "Successfully connected to Socket.io server")
                await sio.disconnect()
                return True
            else:
                self.log_result("Socket.io Connection", False, "Failed to establish Socket.io connection")
                return False
                
        except Exception as e:
            self.log_result("Socket.io Connection", False, f"Connection failed: {str(e)}")
            return False

    async def test_socketio_matchmaking(self):
        """Test Socket.io matchmaking between two clients"""
        try:
            # Create two socket clients
            sio1 = socketio.AsyncClient(logger=False, engineio_logger=False)
            sio2 = socketio.AsyncClient(logger=False, engineio_logger=False)
            
            client1_matched = False
            client2_matched = False
            match_data1 = None
            match_data2 = None
            
            # Client 1 event handlers
            @sio1.event
            async def matched(data):
                nonlocal client1_matched, match_data1
                client1_matched = True
                match_data1 = data
                logger.info(f"Client 1 matched: {data}")
            
            # Client 2 event handlers  
            @sio2.event
            async def matched(data):
                nonlocal client2_matched, match_data2
                client2_matched = True
                match_data2 = data
                logger.info(f"Client 2 matched: {data}")
            
            # Connect first client and add to queue
            await sio1.connect(self.base_url, transports=['websocket', 'polling'])
            await asyncio.sleep(1)
            
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
            
            await sio1.emit('join-queue', queue_data)
            await asyncio.sleep(1)
            
            # Connect second client and add to queue (should trigger match)
            await sio2.connect(self.base_url, transports=['websocket', 'polling'])
            await asyncio.sleep(1)
            await sio2.emit('join-queue', queue_data)
            await asyncio.sleep(2)  # Wait for matching
            
            # Verify matching worked
            if client1_matched and client2_matched:
                if (match_data1 and match_data2 and 
                    match_data1.get('roomId') == match_data2.get('roomId') and
                    match_data1.get('isInitiator') != match_data2.get('isInitiator')):
                    
                    self.log_result("Socket.io Matchmaking", True, 
                                  "Successfully matched two clients with correct room and initiator flags",
                                  {"client1_data": match_data1, "client2_data": match_data2})
                    
                    await sio1.disconnect()
                    await sio2.disconnect()
                    return match_data1.get('roomId')  # Return room ID for next test
                else:
                    self.log_result("Socket.io Matchmaking", False, 
                                  f"Matching data inconsistent: {match_data1} vs {match_data2}")
            else:
                self.log_result("Socket.io Matchmaking", False, 
                              f"Matching failed - Client1: {client1_matched}, Client2: {client2_matched}")
            
            await sio1.disconnect()
            await sio2.disconnect()
            return None
            
        except Exception as e:
            self.log_result("Socket.io Matchmaking", False, f"Test failed: {str(e)}")
            return None

    async def test_socketio_text_chat(self):
        """Test Socket.io text chat functionality"""
        try:
            sio1 = socketio.AsyncClient(logger=False, engineio_logger=False)
            sio2 = socketio.AsyncClient(logger=False, engineio_logger=False)
            
            client1_matched = False
            client2_matched = False
            message_received = False
            received_message_data = None
            room_id = None
            
            @sio1.event
            async def matched(data):
                nonlocal client1_matched, room_id
                client1_matched = True
                room_id = data.get('roomId')
                logger.info(f"Client 1 matched in room: {room_id}")
            
            @sio2.event
            async def matched(data):
                nonlocal client2_matched
                client2_matched = True
                logger.info(f"Client 2 matched in room: {data.get('roomId')}")
            
            @sio2.event
            async def receive_message(data):
                nonlocal message_received, received_message_data
                message_received = True
                received_message_data = data
                logger.info(f"Client 2 received message: {data}")
            
            # Connect first client and add to queue
            await sio1.connect(self.base_url, transports=['websocket', 'polling'])
            await asyncio.sleep(1)
            
            queue_data = {
                'primaryLanguage': {'code': 'en-US', 'name': 'English'},
                'spokenLanguages': [],
                'mode': 'video'
            }
            
            await sio1.emit('join-queue', queue_data)
            await asyncio.sleep(1)
            
            # Connect second client and trigger match
            await sio2.connect(self.base_url, transports=['websocket', 'polling'])
            await asyncio.sleep(1)
            await sio2.emit('join-queue', queue_data)
            await asyncio.sleep(2)
            
            if client1_matched and client2_matched and room_id:
                # Send message from client 1
                message_data = {
                    'roomId': room_id,
                    'message': 'Hello!',
                    'fromLang': 'en'
                }
                await sio1.emit('send-message', message_data)
                await asyncio.sleep(2)
                
                if message_received and received_message_data:
                    if (received_message_data.get('text') == 'Hello!' and
                        received_message_data.get('fromLang') == 'en' and
                        'timestamp' in received_message_data):
                        
                        self.log_result("Socket.io Text Chat", True, 
                                      "Text message successfully sent and received",
                                      {"sent": message_data, "received": received_message_data})
                    else:
                        self.log_result("Socket.io Text Chat", False, 
                                      f"Message format incorrect: {received_message_data}")
                else:
                    self.log_result("Socket.io Text Chat", False, "Message not received by client 2")
            else:
                self.log_result("Socket.io Text Chat", False, "Failed to establish matched connection for chat test")
            
            await sio1.disconnect()
            await sio2.disconnect()
            
        except Exception as e:
            self.log_result("Socket.io Text Chat", False, f"Test failed: {str(e)}")

    async def test_socketio_next_leave(self):
        """Test Socket.io next/leave functionality"""
        try:
            sio1 = socketio.AsyncClient(logger=False, engineio_logger=False)
            sio2 = socketio.AsyncClient(logger=False, engineio_logger=False)
            
            client1_matched = False
            client2_matched = False
            partner_left_received = False
            
            @sio1.event
            async def matched(data):
                nonlocal client1_matched
                client1_matched = True
                logger.info("Client 1 matched")
            
            @sio2.event
            async def matched(data):
                nonlocal client2_matched
                client2_matched = True
                logger.info("Client 2 matched")
            
            @sio2.event
            async def partner_left():
                nonlocal partner_left_received
                partner_left_received = True
                logger.info("Client 2 received partner-left event")
            
            # Connect first client and add to queue
            await sio1.connect(self.base_url, transports=['websocket', 'polling'])
            await asyncio.sleep(1)
            
            queue_data = {
                'primaryLanguage': {'code': 'en-US', 'name': 'English'},
                'spokenLanguages': [],
                'mode': 'video'
            }
            
            await sio1.emit('join-queue', queue_data)
            await asyncio.sleep(1)
            
            # Connect second client and trigger match
            await sio2.connect(self.base_url, transports=['websocket', 'polling'])
            await asyncio.sleep(1)
            await sio2.emit('join-queue', queue_data)
            await asyncio.sleep(2)
            
            if client1_matched and client2_matched:
                # Client 1 emits 'next' to leave
                await sio1.emit('next')
                await asyncio.sleep(2)
                
                if partner_left_received:
                    self.log_result("Socket.io Next/Leave", True, 
                                  "Partner-left event correctly sent when user clicks next")
                else:
                    self.log_result("Socket.io Next/Leave", False, 
                                  "Partner-left event not received by other client")
            else:
                self.log_result("Socket.io Next/Leave", False, 
                              "Failed to establish matched connection for next/leave test")
            
            await sio1.disconnect()
            await sio2.disconnect()
            
        except Exception as e:
            self.log_result("Socket.io Next/Leave", False, f"Test failed: {str(e)}")

    async def run_all_tests(self):
        """Run all backend tests"""
        logger.info("Starting Omingle Backend Test Suite...")
        logger.info(f"Testing against: {self.base_url}")
        
        # Test API endpoints
        self.test_api_health()
        self.test_translation_api()
        
        # Test Socket.io functionality
        await self.test_socketio_connection()
        await self.test_socketio_matchmaking()
        await self.test_socketio_text_chat()
        await self.test_socketio_next_leave()
        
        # Print summary
        self.print_summary()

    def print_summary(self):
        """Print test results summary"""
        logger.info("\n" + "="*50)
        logger.info("TEST RESULTS SUMMARY")
        logger.info("="*50)
        
        passed = sum(1 for r in self.results if r['success'])
        total = len(self.results)
        
        for result in self.results:
            status = "✅ PASS" if result['success'] else "❌ FAIL"
            logger.info(f"{status} {result['test']}: {result['message']}")
        
        logger.info("="*50)
        logger.info(f"TOTAL: {passed}/{total} tests passed")
        logger.info("="*50)
        
        return passed, total

async def main():
    """Main test runner"""
    tester = OmingleTester()
    await tester.run_all_tests()
    return tester.results

if __name__ == "__main__":
    asyncio.run(main())