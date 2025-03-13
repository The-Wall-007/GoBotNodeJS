const express = require("express");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { format } = require("date-fns");
const chrono = require("chrono-node");
const axios = require("axios");
const dotenv = require("dotenv").config();

// Rate limiting utilities
class RateLimiter {
  constructor(maxRequests, timeWindow) {
    this.maxRequests = maxRequests;
    this.timeWindow = timeWindow;
    this.requests = [];
  }

  async waitForAvailableSlot() {
    const now = Date.now();
    this.requests = this.requests.filter(time => now - time < this.timeWindow);
    
    if (this.requests.length >= this.maxRequests) {
      const oldestRequest = this.requests[0];
      const waitTime = this.timeWindow - (now - oldestRequest);
      await new Promise(resolve => setTimeout(resolve, waitTime));
      return this.waitForAvailableSlot();
    }
    
    this.requests.push(now);
    return true;
  }
}

// Retry utility
async function withRetry(fn, maxRetries = 3, delay = 1000) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i === maxRetries - 1) throw error;
      if (error.status === 429) {
        await new Promise(resolve => setTimeout(resolve, delay * Math.pow(2, i)));
        continue;
      }
      throw error;
    }
  }
}

// Initialize rate limiter (10 requests per minute)
const geminiRateLimiter = new RateLimiter(10, 60 * 1000);

const app = express();
const port = process.env.PORT || 3000;

// Environment variables
const MODEL_NAME = "gemini-2.0-flash-exp";
const API_KEY = process.env.API_KEY;
const token = process.env.AUTH_TOKEN;

// Middleware
app.use(express.json());

// Global state
let validLocations = [];
let validLocationLabels = [];
const userSessions = new Map(); // Store booking states per user

// Utility functions
function findLocationMatch(input) {
  const lowerInput = input.toLowerCase().trim();
  
  // Remove common words that might interfere with matching
  const cleanInput = lowerInput
    .replace(/\bat\b/g, '')
    .replace(/\bin\b/g, '')
    .replace(/\bthe\b/g, '')
    .replace(/\bairport\b/g, '')
    .trim();

  return validLocations.filter(
    (loc) => {
      const locValue = loc.value.toLowerCase();
      const locLabel = loc.label.toLowerCase();
      const locAddress = (loc.address || '').toLowerCase();
      
      // Check for exact matches first
      if (locValue === cleanInput || locLabel === cleanInput) {
        return true;
      }
      
      // Then check for partial matches
      return locValue.includes(cleanInput) ||
             locLabel.includes(cleanInput) ||
             locAddress.includes(cleanInput) ||
             // Check for airport codes (e.g., "LAX")
             locValue.includes(cleanInput.toUpperCase()) ||
             locLabel.includes(cleanInput.toUpperCase());
    }
  );
}

const getLocationListDisplay = (locations, page = 1, itemsPerPage = 10) => {
  const start = (page - 1) * itemsPerPage;
  const end = start + itemsPerPage;
  const totalPages = Math.ceil(locations.length / itemsPerPage);
  
  const paginatedLocations = locations.slice(start, end);
  return {
    locationList: paginatedLocations.map((loc, i) => `${start + i + 1}. ${loc.label}`).join('\n'),
    currentPage: page,
    totalPages: totalPages,
    totalLocations: locations.length
  };
};

// Fetch locations from API
const fetchLocations = async () => {
  try {
    console.log("Starting location fetch...");
    if (!token) {
      console.error("Error: AUTH_TOKEN is not set");
      return;
    }
    console.log("Making API request to fetch locations...");
    const response = await axios.get(
      "https://staging.carcierge.gorentals.com/go-app/location",
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      }
    );

    console.log("API Response status:", response.status);
    console.log("API Response data structure:", Object.keys(response.data || {}));

    if (Array.isArray(response.data?.data?.locations)) {
      validLocations = response.data.data.locations;
      validLocationLabels = validLocations.map((loc) => loc.label);
      console.log(`Successfully loaded ${validLocations.length} locations`);
    } else {
      console.error("Invalid response structure:", response.data);
      throw new Error("Expected response.data.data.locations to be an array");
    }
  } catch (error) {
    console.error("Error fetching locations:", {
      message: error.message,
      status: error.response?.status,
      statusText: error.response?.statusText,
      data: error.response?.data
    });
    throw error; // Re-throw to handle in the server startup
  }
};

const getLocationCode = (locationValue) =>
  validLocations.find((location) => location.value === locationValue)?.value;

const formatDateTime = (date, time) => {
  const [hours, minutes] = time.split(":");
  date.setHours(hours);
  date.setMinutes(minutes);
  date.setSeconds(0);

  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(
    2,
    "0"
  )}-${String(date.getDate()).padStart(2, "0")}T${String(hours).padStart(
    2,
    "0"
  )}:${String(minutes).padStart(2, "0")}:00`;
};

const fetchAvailableVehicles = async (
  pickupLocationCode,
  formattedPickupDateTime,
  formattedReturnDateTime,
  token
) => {
  const requestData = {
    locationCode: pickupLocationCode,
    pickupDate: formattedPickupDateTime,
    returnDate: formattedReturnDateTime,
    corpDiscountCode: "PAX",
    type: "go-app",
    travelProfileId: 1,
  };

  try {
    const response = await axios.post(
      "https://staging.carcierge.gorentals.com/go-app/available-vehicles",
      requestData,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      }
    );

    return response.data;
  } catch (error) {
    console.error("Error fetching available vehicles:", error);
    return null;
  }
};

const fetchVehicleFee = async (req, token) => {
  try {
    const response = await axios.post(
      "https://staging.carcierge.gorentals.com/go-app/vehicles-fee",
      req,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      }
    );
    return response.data;
  } catch (error) {
    console.error("Error fetching vehicle fee:", error);
    return null;
  }
};

const createBooking = async (bookingRequest, token) => {
  try {
    const response = await axios.post(
      "https://staging.carcierge.gorentals.com/go-app/create-booking",
      bookingRequest,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      }
    );
    return response.data;
  } catch (error) {
    console.error("Error creating booking:", error);
    return null;
  }
};

// Gemini AI chat
async function runChat(userInput) {
  await geminiRateLimiter.waitForAvailableSlot();
  
  return withRetry(async () => {
    try {
      const genAI = new GoogleGenerativeAI(API_KEY);
      const model = genAI.getGenerativeModel({ model: MODEL_NAME });
      const chat = model.startChat();
      const result = await chat.sendMessage(userInput);
      return result.response.text();
    } catch (error) {
      console.error("Error in runChat:", error);
      if (error.status === 429) {
        throw error; // Let withRetry handle the retry
      }
      // For other errors, return a fallback response
      return handleGeminiError(userInput);
    }
  });
}

// Fallback handler for when Gemini AI fails
function handleGeminiError(userInput) {
  // Simple rule-based fallback for common queries
  const input = userInput.toLowerCase();
  
  if (input.includes("location")) {
    return "Please provide a location from our available locations list.";
  }
  if (input.includes("date")) {
    return "Please provide a date in YYYY-MM-DD format or use natural language like 'tomorrow' or 'next Monday'.";
  }
  if (input.includes("time")) {
    return "Please provide a time in HH:mm format (24-hour) or use natural language like '2pm' or '15:30'.";
  }
  
  return "I'm having trouble processing your request. Please try again or provide your input in a simpler format.";
}

// Add this function before processBookingStep
async function parseEditRequest(userInput) {
  const prompt = `Extract booking modification data from: "${userInput}"

Return ONLY a JSON object with this exact structure:
{
  "fields": ["list of fields to update"],
  "values": {
    "pickupLocation": "location name if specified",
    "pickupDate": "YYYY-MM-DD if specified",
    "pickupTime": "HH:mm if specified",
    "returnLocation": "location name if specified",
    "returnDate": "YYYY-MM-DD if specified",
    "returnTime": "HH:mm if specified"
  }
}

Rules:
1. Only include fields explicitly mentioned in the request
2. For dates: 
   - If year is not specified, use 2025 for dates after today
   - Convert to YYYY-MM-DD format
3. For times: convert to 24-hour HH:mm format
4. For locations: use exact location name
5. Return ONLY the JSON object, no other text

Example:
Input: "change the return date to 12th march 12 pm"
Output: {"fields":["returnDate","returnTime"],"values":{"returnDate":"2025-03-12","returnTime":"12:00"}}`;

  try {
    const response = await runChat(prompt);
    // Clean the response to ensure it's valid JSON
    const cleanResponse = response.trim().replace(/```json\n?|\n?```/g, '');
    const parsedResponse = JSON.parse(cleanResponse);
    
    // Debug logging
    console.log('Parsed edit request:', parsedResponse);
    
    // Validate dates if present
    if (parsedResponse.values) {
      if (parsedResponse.values.returnDate) {
        const returnDate = new Date(parsedResponse.values.returnDate);
        if (!isNaN(returnDate.getTime())) {
          // Format the date back to YYYY-MM-DD
          parsedResponse.values.returnDate = returnDate.toISOString().split('T')[0];
        }
      }
      if (parsedResponse.values.pickupDate) {
        const pickupDate = new Date(parsedResponse.values.pickupDate);
        if (!isNaN(pickupDate.getTime())) {
          // Format the date back to YYYY-MM-DD
          parsedResponse.values.pickupDate = pickupDate.toISOString().split('T')[0];
        }
      }
    }
    
    return parsedResponse;
  } catch (error) {
    console.error("Error parsing edit request:", error);
    return null;
  }
}

// Chat endpoint
app.post("/chat", async (req, res) => {
  try {
    const { userId, userInput } = req.body;
    if (!userId || !userInput) {
      return res.status(400).json({ 
        success: false,
        error: "Invalid request body",
        response: "Please provide both userId and userInput.",
        vehicleList: [],
        bookingDetails: {},
        currentStep: "",
        quickReplies: null
      });
    }

    // Check if locations are loaded
    if (validLocations.length === 0) {
      console.log("Attempting to reload locations...");
      try {
        await fetchLocations();
      } catch (locError) {
        console.error("Error reloading locations:", locError);
        return res.status(503).json({ 
          success: false,
          error: "Service temporarily unavailable", 
          response: "Unable to load location data. Please try again in a few moments.",
          vehicleList: [],
          bookingDetails: {},
          currentStep: "",
          quickReplies: null
        });
      }
    }

    if (!userSessions.has(userId)) {
      userSessions.set(userId, {
        bookingDetails: {},
        currentStep: "greeting",
        currentPage: 1
      });
    }

    const userSession = userSessions.get(userId);
    let botResponse;
    
    try {
      botResponse = await runChat(userInput);
    } catch (chatError) {
      console.error("Error in runChat:", chatError);
      botResponse = handleGeminiError(userInput);
    }

    let responseData = {
      success: true,
      response: "",
      vehicleList: [],
      bookingDetails: userSession.bookingDetails,
      currentStep: userSession.currentStep,
      quickReplies: null
    };

    try {
      const geminiJson = JSON.parse(botResponse);
      Object.assign(userSession.bookingDetails, geminiJson);
    } catch (jsonError) {
      console.log("Non-JSON response from Gemini (expected):", botResponse);
    }

    try {
      const processedResponse = await processBookingStep(userInput, userSession);
      if (processedResponse) {
        responseData = {
          ...responseData,
          ...processedResponse,
          success: true,
          bookingDetails: userSession.bookingDetails,
          currentStep: userSession.currentStep,
          quickReplies: processedResponse.quickReplies || null
        };

        // Add quick replies for specific steps
        if (userSession.currentStep === "updateInfo") {
          responseData.quickReplies = {
            type: "radio",
            keepIt: true,
            values: [
              { title: "Confirm", value: "confirm" },
              { title: "Edit", value: "edit" },
              { title: "Cancel", value: "cancel" }
            ]
          };
        } else if (userSession.currentStep === "greeting") {
          responseData.quickReplies = {
            type: "radio",
            keepIt: true,
            values: [
              { title: "Reserve a vehicle", value: "Reserve a vehicle" }
            ]
          };
        }
      }
    } catch (processError) {
      console.error("Error processing booking step:", processError);
      return res.status(500).json({
        success: false,
        error: "Processing Error",
        response: "I encountered an error while processing your request. Please try again.",
        vehicleList: [],
        bookingDetails: userSession.bookingDetails,
        currentStep: userSession.currentStep,
        quickReplies: null
      });
    }

    // Log the response for debugging
    console.log("Sending response:", JSON.stringify(responseData, null, 2));
    res.json(responseData);
  } catch (error) {
    console.error("Error in chat endpoint:", {
      message: error.message,
      stack: error.stack,
      status: error.response?.status,
      data: error.response?.data
    });
    res.status(500).json({ 
      success: false,
      error: "Internal Server Error",
      response: "An error occurred while processing your request. Please try again.",
      vehicleList: [],
      bookingDetails: {},
      currentStep: "",
      quickReplies: null
    });
  }
});

const extractLocationWithGemini = async (input) => {
  await geminiRateLimiter.waitForAvailableSlot();
  
  return withRetry(async () => {
    const prompt = `Extract ONLY the location name from: "${input}"
Return ONLY the location name, nothing else. If no location is found, return "null".`;

    try {
      const location = await runChat(prompt);
      const trimmedLocation = location.trim().replace(/```json\n?|\n?```/g, '');

      if (trimmedLocation.toLowerCase() === "null") {
        return null;
      }
      return trimmedLocation;
    } catch (error) {
      console.error("Error extracting location with Gemini:", error);
      return null;
    }
  });
};

const extractDateWithGemini = async (input) => {
  await geminiRateLimiter.waitForAvailableSlot();
  
  return withRetry(async () => {
    const today = new Date().toISOString().split("T")[0];
    const prompt = `Extract ONLY the date from: "${input}"
Today's date is ${today}

Return ONLY the date in YYYY-MM-DD format. If no date is found or invalid, return "null".
Examples:
- "tomorrow" → "${format(new Date().setDate(new Date().getDate() + 1), 'yyyy-MM-dd')}"
- "next Monday" → [date of next Monday in YYYY-MM-DD]
- "July 15th" → "2024-07-15"`;

    try {
      const response = await runChat(prompt);
      const trimmedDate = response.trim().replace(/```json\n?|\n?```/g, '');
      
      if (trimmedDate.toLowerCase() === "null") {
        return null;
      }

      // Validate the date format
      const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
      if (!dateRegex.test(trimmedDate)) {
        return null;
      }

      // Check if it's a valid date
      const parsedDate = new Date(trimmedDate);
      if (isNaN(parsedDate.getTime())) {
        return null;
      }

      return trimmedDate;
    } catch (error) {
      console.error("Error extracting date with Gemini:", error);
      return null;
    }
  });
};

const extractTimeWithGemini = async (input) => {
  await geminiRateLimiter.waitForAvailableSlot();
  
  return withRetry(async () => {
    const prompt = `Extract ONLY the time from: "${input}"

Return ONLY the time in 24-hour HH:mm format. If no time is found or invalid, return "null".
Examples:
- "2pm" → "14:00"
- "2:30pm" → "14:30"
- "14:30" → "14:30"
- "9am" → "09:00"
- "9:30" → "09:30"
- "noon" → "12:00"
- "midnight" → "00:00"`;

    try {
      const response = await runChat(prompt);
      const trimmedTime = response.trim().replace(/```json\n?|\n?```/g, '');
      
      if (trimmedTime.toLowerCase() === "null") {
        return null;
      }

      // Validate the time format
      const timeRegex = /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/;
      if (!timeRegex.test(trimmedTime)) {
        return null;
      }

      return trimmedTime;
    } catch (error) {
      console.error("Error extracting time with Gemini:", error);
      return null;
    }
  });
};

const isValidDateTime = (dateStr, timeStr) => {
  if (!dateStr || !timeStr) return false;
  const dateTime = new Date(`${dateStr} ${timeStr}`);
  return dateTime > new Date();
};

const isValidReturnDate = (pickupDate, returnDate) => {
  if (!pickupDate || !returnDate) return true;
  
  // Debug logging
  console.log('Validating return date:', { pickupDate, returnDate });
  
  // Parse dates and ensure they're valid
  const pickup = new Date(pickupDate);
  const returnD = new Date(returnDate);
  
  if (isNaN(pickup.getTime()) || isNaN(returnD.getTime())) {
    console.error('Invalid date format:', { pickupDate, returnDate });
    return false;
  }
  
  // Set both dates to midnight for accurate date comparison
  pickup.setHours(0, 0, 0, 0);
  returnD.setHours(0, 0, 0, 0);
  
  const isValid = returnD >= pickup;
  console.log('Date validation result:', isValid);
  return isValid;
};

const isValidReturnTime = (pickupDate, pickupTime, returnDate, returnTime) => {
  if (!pickupDate || !pickupTime || !returnDate || !returnTime) return true;
  if (pickupDate === returnDate) {
    return (
      new Date(`${returnDate} ${returnTime}`) >
      new Date(`${pickupDate} ${pickupTime}`)
    );
  }
  return true;
};

// Booking step processor
async function processBookingStep(userInput, userSession) {
  const responseData = {
    response: "",
    vehicleList: [],
    bookingDetails: userSession.bookingDetails,
    currentStep: userSession.currentStep,
  };
  const { bookingDetails, currentStep } = userSession;

  // Check if user wants to reserve a vehicle
  if (userInput.toLowerCase().includes("reserve a vehicle")) {
    responseData.response = "I'd be happy to help you reserve a vehicle. Would you like to proceed with making a reservation?";
    userSession.currentStep = "initiate";
    return responseData;
  }

  switch (currentStep) {
    case "greeting":
      if (userInput.toLowerCase() === "yes") {
        responseData.response = "Excellent! Let's find you the perfect vehicle. First, I'll need to know:\n\n1. Your pickup location\n2. Pickup date\n3. Pickup time\n\nYou can provide these details separately or all at once. Where would you like to pick up your vehicle?";
        userSession.currentStep = "pickupLocation";
      } else {
        responseData.response = "Hello! I'm your car rental assistant. Would you like to reserve a vehicle today? Simply say 'yes' to begin, or 'reserve a vehicle' anytime you're ready.";
        userSession.currentStep = "greeting";
      }
      break;

    case "initiate":
      if (userInput.toLowerCase() === "yes") {
        responseData.response = "Excellent! Let's find you the perfect vehicle. First, I'll need to know:\n\n1. Your pickup location\n2. Pickup date\n3. Pickup time\n\nYou can provide these details separately or all at once. Where would you like to pick up your vehicle?";
        userSession.currentStep = "pickupLocation";
      } else if (userInput.toLowerCase() === "no") {
        responseData.response = "No problem! Whenever you're ready to make a reservation, just say 'reserve a vehicle'.";
        userSession.currentStep = "greeting";
      } else {
        responseData.response = "I didn't quite catch that. Please say 'yes' to start a reservation, or 'no' if you'd like to do this later.";
        userSession.currentStep = "initiate";
      }
      break;

    case "pickupLocation":
    case "pickupDate":
    case "pickupTime": {
      let updatedInfo = false;
      
      // Extract all information simultaneously
      const [locationText, date, time] = await Promise.all([
        extractLocationWithGemini(userInput),
        extractDateWithGemini(userInput),
        extractTimeWithGemini(userInput)
      ]);
      
      // Process location if not already set
      if (!bookingDetails.pickupLocation && locationText) {
        const locationMatches = findLocationMatch(locationText);
        if (locationMatches.length === 1) {
          bookingDetails.pickupLocation = locationMatches[0];
          updatedInfo = true;
        } else if (locationMatches.length > 1) {
          const locationDisplay = getLocationListDisplay(locationMatches);
          responseData.response = `I found several possible pickup locations:\n\n${locationDisplay.locationList}\n\n` +
            `Page ${locationDisplay.currentPage} of ${locationDisplay.totalPages}\n` +
            `Please choose one by number or name, or type 'more' to see more options.`;
          responseData.quickReplies = {
            type: "radio",
            keepIt: true,
            values: locationMatches.slice(0, 10).map(loc => ({
              title: loc.label,
              value: loc.label
            }))
          };
          
          // Store any valid date/time we found for later use
          if (date) bookingDetails._tempDate = date;
          if (time) bookingDetails._tempTime = time;
          
          return responseData;
        }
      }

      // Process date if not already set
      if (!bookingDetails.pickupDate && (date || bookingDetails._tempDate)) {
        const dateToUse = date || bookingDetails._tempDate;
        bookingDetails.pickupDate = dateToUse;
        delete bookingDetails._tempDate;
        updatedInfo = true;
      }

      // Process time if not already set
      if (!bookingDetails.pickupTime && (time || bookingDetails._tempTime)) {
        const timeToUse = time || bookingDetails._tempTime;
        bookingDetails.pickupTime = timeToUse;
        delete bookingDetails._tempTime;
        updatedInfo = true;
      }

      // If we have all pickup details, show summary and move to return details
      if (bookingDetails.pickupLocation && bookingDetails.pickupDate && bookingDetails.pickupTime) {
        if (!isValidDateTime(bookingDetails.pickupDate, bookingDetails.pickupTime)) {
          responseData.response = "I notice you've selected a date/time in the past. Please provide a future date and time for your pickup.";
          delete bookingDetails.pickupDate;
          delete bookingDetails.pickupTime;
          return responseData;
        }
        
        responseData.response = `Perfect! Here's what I have for your pickup:\n\nLocation: ${bookingDetails.pickupLocation.label}\nDate: ${bookingDetails.pickupDate}\nTime: ${bookingDetails.pickupTime}\n\nNow, let's set up your return. Where would you like to return the vehicle?`;
        userSession.currentStep = "returnLocation";
        return responseData;
      } else {
        // If no location is set and no valid input was provided, show location list
        if (!bookingDetails.pickupLocation) {
          const locationDisplay = getLocationListDisplay(validLocations);
          responseData.response = `I couldn't find that location in our system. Here are some available locations:\n\n${locationDisplay.locationList}\n\n` +
            `Showing page ${locationDisplay.currentPage} of ${locationDisplay.totalPages}\n` +
            `Please choose one from the list, or type 'more' to see more options.`;
          responseData.quickReplies = {
            type: "radio",
            keepIt: true,
            values: validLocations.slice(0, 10).map(loc => ({
              title: loc.label,
              value: loc.label
            }))
          };
          
          // Store any valid date/time we found for later use
          if (date) bookingDetails._tempDate = date;
          if (time) bookingDetails._tempTime = time;
          
          return responseData;
        }
        
        // Guide user on what's missing
        const missing = [];
        if (!bookingDetails.pickupLocation) missing.push("pickup location");
        if (!bookingDetails.pickupDate) missing.push("pickup date");
        if (!bookingDetails.pickupTime) missing.push("pickup time");
        
        const missingFields = missing.length === 1 
          ? `your ${missing[0]}`
          : missing.length === 2 
            ? `your ${missing[0]} and ${missing[1]}`
            : `your ${missing.slice(0, -1).join(", ")}, and ${missing[missing.length - 1]}`;

        const helpText = [
          `To proceed with your booking, I'll need ${missingFields}.`,
          "",
          "You can provide:",
          missing.includes("pickup location") ? `• Location: Choose from our available locations:\n${validLocationLabels.map((label, i) => `  ${i + 1}. ${label}`).join('\n')}` : null,
          missing.includes("pickup date") ? "• Date: Use natural language like 'tomorrow' or 'next Monday'" : null,
          missing.includes("pickup time") ? "• Time: Use formats like '2pm' or '14:30'" : null
        ].filter(Boolean).join("\n");

        responseData.response = helpText;
        return responseData;
      }
      break;
    }

    case "returnLocation":
    case "returnDate":
    case "returnTime": {
      let updatedInfo = false;
      let processedDate = false;
      let processedTime = false;
      
      // Always try to extract all information (location, date, and time) from input
      const [locationText, date, time] = await Promise.all([
        extractLocationWithGemini(userInput),
        extractDateWithGemini(userInput),
        extractTimeWithGemini(userInput)
      ]);

      // Process location if not already set
      if (!bookingDetails.returnLocation && locationText) {
        const locationMatches = findLocationMatch(locationText);
        if (locationMatches.length === 1) {
          bookingDetails.returnLocation = locationMatches[0];
          updatedInfo = true;
        } else if (locationMatches.length > 1) {
          const locationDisplay = getLocationListDisplay(locationMatches);
          responseData.response = `I found several possible return locations:\n\n${locationDisplay.locationList}\n\n` +
            `Page ${locationDisplay.currentPage} of ${locationDisplay.totalPages}\n` +
            `Please choose one by number or name, or type 'more' to see more options.`;
          responseData.quickReplies = {
            type: "radio",
            keepIt: true,
            values: locationMatches.slice(0, 10).map(loc => ({
              title: loc.label,
              value: loc.label
            }))
          };
          return responseData;
        }
      }

      // Process date if not already set
      if (!bookingDetails.returnDate && date) {
        if (!isValidReturnDate(bookingDetails.pickupDate, date)) {
          responseData.response = `The return date must be on or after your pickup date (${bookingDetails.pickupDate}). You can:\n\n` +
            `1. Choose a later return date (on or after ${bookingDetails.pickupDate})\n` +
            `2. Type "2" to modify the pickup date instead\n` +
            `3. Type "cancel" to start over`;
          userSession.currentStep = "updateFieldSelection";
          return responseData;
        }
        bookingDetails.returnDate = date;
        updatedInfo = true;
        processedDate = true;
      }

      // Process time if not already set
      if (!bookingDetails.returnTime && time) {
        if (bookingDetails.returnDate === bookingDetails.pickupDate && 
            !isValidReturnTime(bookingDetails.pickupDate, bookingDetails.pickupTime, bookingDetails.returnDate, time)) {
          responseData.response = `The pickup time (${time}) would be after your current return time (${bookingDetails.returnTime}). You can:\n\n` +
            `1. Choose an earlier pickup time (before ${bookingDetails.returnTime})\n` +
            `2. Type "6" to modify the return time instead\n` +
            `3. Type "cancel" to start over`;
          userSession.currentStep = "updateFieldSelection";
          return responseData;
        }
        bookingDetails.returnTime = time;
        updatedInfo = true;
        processedTime = true;
      }

      // If we have all return details, show summary and proceed
      if (bookingDetails.returnLocation && bookingDetails.returnDate && bookingDetails.returnTime) {
        // Prepare booking summary
        const summary = `Perfect! Here's your complete booking summary:\n\n` +
          `📍 PICKUP\n` +
          `• Location: ${bookingDetails.pickupLocation.label}\n` +
          `• Date: ${bookingDetails.pickupDate}\n` +
          `• Time: ${bookingDetails.pickupTime}\n\n` +
          `📍 RETURN\n` +
          `• Location: ${bookingDetails.returnLocation.label}\n` +
          `• Date: ${bookingDetails.returnDate}\n` +
          `• Time: ${bookingDetails.returnTime}\n\n` +
          `Would you like to:\n` +
          `1. Confirm this booking (type 'confirm')\n` +
          `2. Make changes (type 'edit')\n` +
          `3. Start over (type 'cancel')`;

        // Fetch available vehicles
        const pickupLocationCode = getLocationCode(bookingDetails.pickupLocation.value);
        const formattedPickupDateTime = formatDateTime(new Date(bookingDetails.pickupDate), bookingDetails.pickupTime);
        const formattedReturnDateTime = formatDateTime(new Date(bookingDetails.returnDate), bookingDetails.returnTime);

        const vehicleListRes = await fetchAvailableVehicles(
          pickupLocationCode,
          formattedPickupDateTime,
          formattedReturnDateTime,
          token
        );

        if (vehicleListRes?.success && vehicleListRes.data.allVehicles) {
          responseData.vehicleList = vehicleListRes.data.allVehicles;
          responseData.response = summary;
          userSession.currentStep = "updateInfo";
        } else {
          responseData.response = "I apologize, but I couldn't find any vehicles available for your selected dates and locations. Would you like to:\n\n" +
            "1. Try different dates (type 'edit')\n" +
            "2. Try different locations (type 'edit')\n" +
            "3. Start over (type 'cancel')";
          userSession.currentStep = "updateInfo";
        }
        return responseData;
      } else if (updatedInfo) {
        // If we updated some information but not all, show what's still needed
        const missing = [];
        if (!bookingDetails.returnLocation) missing.push("return location");
        if (!bookingDetails.returnDate) missing.push("return date");
        if (!bookingDetails.returnTime) missing.push("return time");
        
        const missingFields = missing.length === 1 
          ? `your ${missing[0]}`
          : missing.length === 2 
            ? `your ${missing[0]} and ${missing[1]}`
            : `your ${missing.slice(0, -1).join(", ")}, and ${missing[missing.length - 1]}`;

        const helpText = [
          `To complete your booking, I'll need ${missingFields}.`,
          "",
          "You can provide:",
          missing.includes("return location") ? "• Location: Choose from our available locations or type the location name" : null,
          missing.includes("return date") ? "• Date: Use natural language like 'tomorrow' or 'next Friday'" : null,
          missing.includes("return time") ? "• Time: Use formats like '2pm' or '14:30'" : null
        ].filter(Boolean).join("\n");

        responseData.response = helpText;
        return responseData;
      } else if (!bookingDetails.returnLocation) {
        // If no location is set and no valid input was provided, show location list
        const locationDisplay = getLocationListDisplay(validLocations);
        responseData.response = `I couldn't find that location in our system. Here are some available locations:\n\n${locationDisplay.locationList}\n\n` +
          `Showing page ${locationDisplay.currentPage} of ${locationDisplay.totalPages}\n` +
          `Please choose one from the list, or type 'more' to see more options.`;
        responseData.quickReplies = {
          type: "radio",
          keepIt: true,
          values: validLocations.slice(0, 10).map(loc => ({
            title: loc.label,
            value: loc.label
          }))
        };
        return responseData;
      }
      break;
    }

    case "updateInfo": {
      const userInputLower = userInput.toLowerCase().trim();

      if (userInputLower === "confirm") {
        // Fetch available vehicles again
        const pickupLocationCode = getLocationCode(bookingDetails.pickupLocation.value);
        const formattedPickupDateTime = formatDateTime(new Date(bookingDetails.pickupDate), bookingDetails.pickupTime);
        const formattedReturnDateTime = formatDateTime(new Date(bookingDetails.returnDate), bookingDetails.returnTime);

        const vehicleListRes = await fetchAvailableVehicles(
          pickupLocationCode,
          formattedPickupDateTime,
          formattedReturnDateTime,
          token
        );

        if (vehicleListRes?.success && vehicleListRes.data.allVehicles) {
          responseData.vehicleList = vehicleListRes.data.allVehicles;
          responseData.response = `Here are the available vehicles for your updated booking:\n\n` +
            `📍 PICKUP\n` +
            `• Location: ${bookingDetails.pickupLocation.label}\n` +
            `• Date: ${bookingDetails.pickupDate}\n` +
            `• Time: ${bookingDetails.pickupTime}\n\n` +
            `📍 RETURN\n` +
            `• Location: ${bookingDetails.returnLocation.label}\n` +
            `• Date: ${bookingDetails.returnDate}\n` +
            `• Time: ${bookingDetails.returnTime}`;
        } else {
          responseData.response = "I apologize, but I couldn't find any vehicles available for your selected dates and locations. Would you like to:\n\n" +
            "1. Try different dates (type 'edit')\n" +
            "2. Try different locations (type 'edit')\n" +
            "3. Start over (type 'cancel')";
          userSession.currentStep = "updateInfo";
          return responseData;
        }
      } else if (userInputLower === "edit") {
        // Instead of cancelling, transition to updateFieldSelection
        responseData.response = `Current Booking Details:\n\n` +
          `📍 PICKUP\n` +
          `• Location: ${bookingDetails.pickupLocation.label}\n` +
          `• Date: ${bookingDetails.pickupDate}\n` +
          `• Time: ${bookingDetails.pickupTime}\n\n` +
          `📍 RETURN\n` +
          `• Location: ${bookingDetails.returnLocation.label}\n` +
          `• Date: ${bookingDetails.returnDate}\n` +
          `• Time: ${bookingDetails.returnTime}\n\n` +
          `To modify your booking, you can:\n\n` +
          `1. Use natural language (e.g., "change pickup location to JFK")\n` +
          `2. Enter a number (1-6):\n` +
          `   1 - Pickup Location\n` +
          `   2 - Pickup Date\n` +
          `   3 - Pickup Time\n` +
          `   4 - Return Location\n` +
          `   5 - Return Date\n` +
          `   6 - Return Time\n\n` +
          `3. Type "done" when finished\n` +
          `4. Type "cancel" to start over`;
        userSession.currentStep = "updateFieldSelection";
        return responseData;
      } else {
        responseData.response = "Please choose one of these options:\n\n1. Type 'confirm' to proceed with the booking\n2. Type 'edit' to make changes\n3. Type 'cancel' to start over";
      }
      break;
    }

    case "updateFieldSelection": {
      // Handle numeric input first
      const numericInput = parseInt(userInput);
      if (!isNaN(numericInput) && numericInput >= 1 && numericInput <= 6) {
        const fields = ["pickupLocation", "pickupDate", "pickupTime", "returnLocation", "returnDate", "returnTime"];
        const fieldLabels = ["Pickup Location", "Pickup Date", "Pickup Time", "Return Location", "Return Date", "Return Time"];
        const selectedField = fields[numericInput - 1];
        const selectedLabel = fieldLabels[numericInput - 1];
        
        let helpMessage = "";
        if (selectedField.includes("Location")) {
          const locationDisplay = getLocationListDisplay(validLocations);
          helpMessage = `Please choose from our available locations:\n\n${locationDisplay.locationList}\n\n` +
            `Showing page ${locationDisplay.currentPage} of ${locationDisplay.totalPages}\n` +
            `Please choose one from the list, or type 'more' to see more options.`;
          responseData.quickReplies = {
            type: "radio",
            keepIt: true,
            values: validLocations.slice(0, 10).map(loc => ({
              title: loc.label,
              value: loc.label
            }))
          };
        } else if (selectedField.includes("Date")) {
          helpMessage = "Please provide the new date (e.g., 'tomorrow', 'next Friday', 'July 15th').";
        } else {
          helpMessage = "Please provide the new time (e.g., '2pm', '14:30').";
        }
        
        responseData.response = `You're updating the ${selectedLabel}. ${helpMessage}`;
        userSession.editingField = selectedField;
        userSession.currentStep = "editField";
        return responseData;
      }

      // Handle special commands
      const userInputLower = userInput.toLowerCase().trim();
      if (userInputLower === "done") {
        responseData.response = `Here's your updated booking summary:\n\n` +
          `📍 PICKUP\n` +
          `• Location: ${bookingDetails.pickupLocation.label}\n` +
          `• Date: ${bookingDetails.pickupDate}\n` +
          `• Time: ${bookingDetails.pickupTime}\n\n` +
          `📍 RETURN\n` +
          `• Location: ${bookingDetails.returnLocation.label}\n` +
          `• Date: ${bookingDetails.returnDate}\n` +
          `• Time: ${bookingDetails.returnTime}\n\n` +
          `Would you like to:\n` +
          `1. Confirm this booking (type 'confirm')\n` +
          `2. Make more changes (type 'edit')\n` +
          `3. Start over (type 'cancel')`;
        userSession.currentStep = "updateInfo";
        return responseData;
      } else if (userInputLower === "cancel") {
        responseData.response = "I've cancelled your booking. When you're ready to make a new reservation, just say 'reserve a vehicle'.";
        userSession.currentStep = "greeting";
        userSession.bookingDetails = {};
        return responseData;
      } else {
        // Try to parse as natural language edit request
        const editRequest = await parseEditRequest(userInput);
        if (editRequest && editRequest.fields.length > 0) {
          let updates = {};
          let errors = [];

          // Process each field update
          for (const field of editRequest.fields) {
            const newValue = editRequest.values[field];
            if (!newValue) continue;

            try {
              if (field.includes("Location")) {
                const locationMatches = findLocationMatch(newValue);
                if (locationMatches.length === 1) {
                  updates[field] = locationMatches[0];
                } else if (locationMatches.length > 1) {
                  errors.push(`Multiple locations found for "${newValue}". Please be more specific.`);
                } else {
                  errors.push(`Location "${newValue}" not found. Please choose from our available locations.`);
                }
              } else if (field.includes("Date")) {
                const date = await extractDateWithGemini(newValue);
                if (date) {
                  // Validate date based on field type
                  if (field === "pickupDate") {
                    const now = new Date();
                    const pickupDate = new Date(date);
                    if (pickupDate < now) {
                      errors.push("Pickup date must be in the future.");
                      continue;
                    }
                    if (bookingDetails.returnDate && !isValidReturnDate(date, bookingDetails.returnDate)) {
                      errors.push(`Pickup date (${date}) cannot be after return date (${bookingDetails.returnDate}).`);
                      continue;
                    }
                  } else if (field === "returnDate") {
                    if (!isValidReturnDate(bookingDetails.pickupDate, date)) {
                      errors.push(`Return date must be on or after pickup date (${bookingDetails.pickupDate}).`);
                      continue;
                    }
                  }
                  updates[field] = date;
                } else {
                  errors.push(`Invalid date format for ${field}. Please use formats like 'tomorrow' or '2024-03-15'.`);
                }
              } else if (field.includes("Time")) {
                const time = await extractTimeWithGemini(newValue);
                if (time) {
                  // Validate time based on field type
                  if (field === "pickupTime") {
                    const now = new Date();
                    const today = now.toISOString().split('T')[0];
                    if (bookingDetails.pickupDate === today) {
                      const pickupDateTime = new Date(`${bookingDetails.pickupDate} ${time}`);
                      if (pickupDateTime <= now) {
                        errors.push("For today's rentals, pickup time must be in the future.");
                        continue;
                      }
                    }
                    if (bookingDetails.returnDate === bookingDetails.pickupDate && bookingDetails.returnTime &&
                        !isValidReturnTime(bookingDetails.pickupDate, time, bookingDetails.returnDate, bookingDetails.returnTime)) {
                      errors.push(`Pickup time cannot be after return time on the same day.`);
                      continue;
                    }
                  } else if (field === "returnTime") {
                    if (bookingDetails.returnDate === bookingDetails.pickupDate && 
                        !isValidReturnTime(bookingDetails.pickupDate, bookingDetails.pickupTime, bookingDetails.returnDate, time)) {
                      errors.push(`Return time must be after pickup time on the same day.`);
                      continue;
                    }
                  }
                  updates[field] = time;
                } else {
                  errors.push(`Invalid time format for ${field}. Please use formats like '2pm' or '14:30'.`);
                }
              }
            } catch (error) {
              console.error(`Error processing ${field}:`, error);
              errors.push(`Error processing ${field}. Please try again.`);
            }
          }

          // Apply updates if no errors
          if (errors.length === 0) {
            Object.assign(bookingDetails, updates);
            responseData.response = `I've updated your booking details:\n\n` +
              `📍 PICKUP\n` +
              `• Location: ${bookingDetails.pickupLocation.label}\n` +
              `• Date: ${bookingDetails.pickupDate}\n` +
              `• Time: ${bookingDetails.pickupTime}\n\n` +
              `📍 RETURN\n` +
              `• Location: ${bookingDetails.returnLocation.label}\n` +
              `• Date: ${bookingDetails.returnDate}\n` +
              `• Time: ${bookingDetails.returnTime}\n\n` +
              `Would you like to:\n` +
              `1. Confirm these changes (type 'confirm')\n` +
              `2. Make more changes (type 'edit')\n` +
              `3. Start over (type 'cancel')`;
            userSession.currentStep = "updateInfo";
            return responseData;
          } else {
            // Show errors and current state
            responseData.response = `I couldn't process some of your changes:\n\n${errors.join('\n')}\n\n` +
              `Current Booking Details:\n\n` +
              `📍 PICKUP\n` +
              `• Location: ${bookingDetails.pickupLocation.label}\n` +
              `• Date: ${bookingDetails.pickupDate}\n` +
              `• Time: ${bookingDetails.pickupTime}\n\n` +
              `📍 RETURN\n` +
              `• Location: ${bookingDetails.returnLocation.label}\n` +
              `• Date: ${bookingDetails.returnDate}\n` +
              `• Time: ${bookingDetails.returnTime}\n\n` +
              `You can:\n` +
              `1. Try again with corrected values\n` +
              `2. Use the numbered menu (1-6) to modify specific fields\n` +
              `3. Type "cancel" to start over`;
            return responseData;
          }
        }
      }

      // If no valid input, show the options again
      responseData.response = `Current Booking Details:\n\n` +
        `📍 PICKUP\n` +
        `• Location: ${bookingDetails.pickupLocation.label}\n` +
        `• Date: ${bookingDetails.pickupDate}\n` +
        `• Time: ${bookingDetails.pickupTime}\n\n` +
        `📍 RETURN\n` +
        `• Location: ${bookingDetails.returnLocation.label}\n` +
        `• Date: ${bookingDetails.returnDate}\n` +
        `• Time: ${bookingDetails.returnTime}\n\n` +
        `To modify your booking, you can:\n\n` +
        `1. Use natural language (e.g., "change pickup location to JFK")\n` +
        `2. Enter a number (1-6):\n` +
        `   1 - Pickup Location\n` +
        `   2 - Pickup Date\n` +
        `   3 - Pickup Time\n` +
        `   4 - Return Location\n` +
        `   5 - Return Date\n` +
        `   6 - Return Time\n\n` +
        `3. Type "done" when finished\n` +
        `4. Type "cancel" to start over`;
      return responseData;
    }

    case "editField": {
      const { editingField } = userSession;
      
      // Handle 'more' command for location pagination
      if (editingField.includes("Location") && userInput.toLowerCase().trim() === 'more') {
        userSession.currentPage = (userSession.currentPage || 1) + 1;
        const locationDisplay = getLocationListDisplay(validLocations, userSession.currentPage);
        
        // Reset to first page if we've reached the end
        if (userSession.currentPage > locationDisplay.totalPages) {
          userSession.currentPage = 1;
          locationDisplay = getLocationListDisplay(validLocations, 1);
        }
        
        responseData.response = `Here are more locations:\n\n${locationDisplay.locationList}\n\n` +
          `Page ${locationDisplay.currentPage} of ${locationDisplay.totalPages}\n` +
          `Please choose one from the list, or type 'more' to see more options.`;
        responseData.quickReplies = {
          type: "radio",
          keepIt: true,
          values: validLocations
            .slice((locationDisplay.currentPage - 1) * 10, locationDisplay.currentPage * 10)
            .map(loc => ({
              title: loc.label,
              value: loc.label
            }))
        };
        return responseData;
      }
      
      if (editingField.includes("Location")) {
        const locationText = await extractLocationWithGemini(userInput);
        if (locationText) {
          const locationMatches = findLocationMatch(locationText);
          if (locationMatches.length === 1) {
            bookingDetails[editingField] = locationMatches[0];
            userSession.currentStep = "updateFieldSelection";
            responseData.response = `Current Booking Details:\n\n` +
              `📍 PICKUP\n` +
              `• Location: ${bookingDetails.pickupLocation.label}\n` +
              `• Date: ${bookingDetails.pickupDate}\n` +
              `• Time: ${bookingDetails.pickupTime}\n\n` +
              `📍 RETURN\n` +
              `• Location: ${bookingDetails.returnLocation.label}\n` +
              `• Date: ${bookingDetails.returnDate}\n` +
              `• Time: ${bookingDetails.returnTime}\n\n` +
              `To modify another field:\n\n` +
              `1. Enter a number (1-6):\n` +
              `   1 - Pickup Location\n` +
              `   2 - Pickup Date\n` +
              `   3 - Pickup Time\n` +
              `   4 - Return Location\n` +
              `   5 - Return Date\n` +
              `   6 - Return Time\n\n` +
              `2. Type "done" when finished\n` +
              `3. Type "cancel" to start over`;
            return responseData;
          } else if (locationMatches.length > 1) {
            const locationDisplay = getLocationListDisplay(locationMatches);
            responseData.response = `I found several possible locations:\n\n${locationDisplay.locationList}\n\n` +
              `Please choose one from the list, or type 'more' to see more options.`;
            responseData.quickReplies = {
              type: "radio",
              keepIt: true,
              values: locationMatches.slice(0, 10).map(loc => ({
                title: loc.label,
                value: loc.label
              }))
            };
            return responseData;
          }
        }
        // Show location list if no match found
        const locationDisplay = getLocationListDisplay(validLocations);
        responseData.response = `I couldn't find that location. Please choose from:\n\n${locationDisplay.locationList}\n\n` +
          `Showing page ${locationDisplay.currentPage} of ${locationDisplay.totalPages}\n` +
          `Please choose one from the list, or type 'more' to see more options.`;
        responseData.quickReplies = {
          type: "radio",
          keepIt: true,
          values: validLocations.slice(0, 10).map(loc => ({
            title: loc.label,
            value: loc.label
          }))
        };
        return responseData;
      } else if (editingField.includes("Date")) {
        const date = await extractDateWithGemini(userInput);
        if (date) {
          // Validate pickup date is in the future
          if (editingField === "pickupDate") {
            const now = new Date();
            const pickupDate = new Date(date);
            if (pickupDate < now) {
              responseData.response = "The pickup date must be in the future. Please provide a valid date.";
              return responseData;
            }
            // If changing pickup date, validate return date if it exists
            if (bookingDetails.returnDate && !isValidReturnDate(date, bookingDetails.returnDate)) {
              responseData.response = `The pickup date (${date}) would be after your current return date (${bookingDetails.returnDate}). You can:\n\n` +
                `1. Choose an earlier pickup date (before ${bookingDetails.returnDate})\n` +
                `2. Type "5" to modify the return date instead\n` +
                `3. Type "cancel" to start over`;
              userSession.currentStep = "updateFieldSelection";
              return responseData;
            }
          } else if (editingField === "returnDate") {
            if (!isValidReturnDate(bookingDetails.pickupDate, date)) {
              responseData.response = `The return date must be on or after your pickup date (${bookingDetails.pickupDate}). You can:\n\n` +
                `1. Choose a later return date (on or after ${bookingDetails.pickupDate})\n` +
                `2. Type "2" to modify the pickup date instead\n` +
                `3. Type "cancel" to start over`;
              userSession.currentStep = "updateFieldSelection";
              return responseData;
            }
          }
          bookingDetails[editingField] = date;
          userSession.currentStep = "updateFieldSelection";
          responseData.response = `Current Booking Details:\n\n` +
            `📍 PICKUP\n` +
            `• Location: ${bookingDetails.pickupLocation.label}\n` +
            `• Date: ${bookingDetails.pickupDate}\n` +
            `• Time: ${bookingDetails.pickupTime}\n\n` +
            `📍 RETURN\n` +
            `• Location: ${bookingDetails.returnLocation.label}\n` +
            `• Date: ${bookingDetails.returnDate}\n` +
            `• Time: ${bookingDetails.returnTime}\n\n` +
            `To modify another field:\n\n` +
            `1. Enter a number (1-6):\n` +
            `   1 - Pickup Location\n` +
            `   2 - Pickup Date\n` +
            `   3 - Pickup Time\n` +
            `   4 - Return Location\n` +
            `   5 - Return Date\n` +
            `   6 - Return Time\n\n` +
            `2. Type "done" when finished\n` +
            `3. Type "cancel" to start over`;
          return responseData;
        }
        responseData.response = "I couldn't understand that date. Please provide a date like 'tomorrow', 'next Friday', or 'July 15th'.";
        return responseData;
      } else if (editingField.includes("Time")) {
        const time = await extractTimeWithGemini(userInput);
        if (time) {
          // Validate pickup time is in the future if it's today
          if (editingField === "pickupTime") {
            const now = new Date();
            const today = now.toISOString().split('T')[0];
            if (bookingDetails.pickupDate === today) {
              const pickupDateTime = new Date(`${bookingDetails.pickupDate} ${time}`);
              if (pickupDateTime <= now) {
                responseData.response = "For today's rentals, the pickup time must be in the future. Please provide a valid time.";
                return responseData;
              }
            }
            // If changing pickup time, validate return time if it's the same day
            if (bookingDetails.returnDate === bookingDetails.pickupDate && bookingDetails.returnTime &&
                !isValidReturnTime(bookingDetails.pickupDate, time, bookingDetails.returnDate, bookingDetails.returnTime)) {
              responseData.response = `The pickup time (${time}) would be after your current return time (${bookingDetails.returnTime}). You can:\n\n` +
                `1. Choose an earlier pickup time (before ${bookingDetails.returnTime})\n` +
                `2. Type "6" to modify the return time instead\n` +
                `3. Type "cancel" to start over`;
              userSession.currentStep = "updateFieldSelection";
              return responseData;
            }
          } else if (editingField === "returnTime") {
            if (bookingDetails.returnDate === bookingDetails.pickupDate && 
                !isValidReturnTime(bookingDetails.pickupDate, bookingDetails.pickupTime, bookingDetails.returnDate, time)) {
              responseData.response = `For same-day rentals, the return time must be after your pickup time (${bookingDetails.pickupTime}). You can:\n\n` +
                `1. Choose a later return time (after ${bookingDetails.pickupTime})\n` +
                `2. Type "3" to modify the pickup time instead\n` +
                `3. Type "cancel" to start over`;
              userSession.currentStep = "updateFieldSelection";
              return responseData;
            }
          }
          bookingDetails[editingField] = time;
          userSession.currentStep = "updateFieldSelection";
          responseData.response = `Current Booking Details:\n\n` +
            `📍 PICKUP\n` +
            `• Location: ${bookingDetails.pickupLocation.label}\n` +
            `• Date: ${bookingDetails.pickupDate}\n` +
            `• Time: ${bookingDetails.pickupTime}\n\n` +
            `📍 RETURN\n` +
            `• Location: ${bookingDetails.returnLocation.label}\n` +
            `• Date: ${bookingDetails.returnDate}\n` +
            `• Time: ${bookingDetails.returnTime}\n\n` +
            `To modify another field:\n\n` +
            `1. Enter a number (1-6):\n` +
            `   1 - Pickup Location\n` +
            `   2 - Pickup Date\n` +
            `   3 - Pickup Time\n` +
            `   4 - Return Location\n` +
            `   5 - Return Date\n` +
            `   6 - Return Time\n\n` +
            `2. Type "done" when finished\n` +
            `3. Type "cancel" to start over`;
          return responseData;
        }
        responseData.response = "I couldn't understand that time. Please provide a time like '2pm', '14:30', or '9:00'.";
        return responseData;
      }
      
      responseData.response = "I couldn't understand your input. Please try again or type 'cancel' to start over.";
      return responseData;
    }

    case "confirmation": {
      const userInputLower = userInput.toLowerCase().trim();

      if (userInputLower === "confirm") {
        // Fetch available vehicles again
        const pickupLocationCode = getLocationCode(bookingDetails.pickupLocation.value);
        const formattedPickupDateTime = formatDateTime(new Date(bookingDetails.pickupDate), bookingDetails.pickupTime);
        const formattedReturnDateTime = formatDateTime(new Date(bookingDetails.returnDate), bookingDetails.returnTime);

        const vehicleListRes = await fetchAvailableVehicles(
          pickupLocationCode,
          formattedPickupDateTime,
          formattedReturnDateTime,
          token
        );

        if (vehicleListRes?.success && vehicleListRes.data.allVehicles) {
          responseData.vehicleList = vehicleListRes.data.allVehicles;
          responseData.response = `Here are the available vehicles for your updated booking:\n\n` +
            `📍 PICKUP\n` +
            `• Location: ${bookingDetails.pickupLocation.label}\n` +
            `• Date: ${bookingDetails.pickupDate}\n` +
            `• Time: ${bookingDetails.pickupTime}\n\n` +
            `📍 RETURN\n` +
            `• Location: ${bookingDetails.returnLocation.label}\n` +
            `• Date: ${bookingDetails.returnDate}\n` +
            `• Time: ${bookingDetails.returnTime}`;
        } else {
          responseData.response = "I apologize, but I couldn't find any vehicles available for your selected dates and locations. Would you like to:\n\n" +
            "1. Try different dates (type 'edit')\n" +
            "2. Try different locations (type 'edit')\n" +
            "3. Start over (type 'cancel')";
          userSession.currentStep = "updateInfo";
          return responseData;
        }
      } else if (userInputLower === "edit") {
        responseData.response = "I've cancelled your booking. When you're ready to make a new reservation, just say 'reserve a vehicle'.";
        userSession.currentStep = "greeting";
        // Clear booking details
        userSession.bookingDetails = {};
      } else {
        responseData.response = "Please choose one of these options:\n\n1. Type 'confirm' to proceed with the booking\n2. Type 'edit' to start over";
      }
      break;
    }
  }

  return responseData;
}

// Start server
app.listen(port, async () => {
  console.log(`Server is running on port ${port}`);
  try {
    console.log("Fetching available locations...");
    await fetchLocations();
    console.log(`Successfully loaded ${validLocations.length} locations`);
    if (validLocations.length === 0) {
      console.error("Warning: No locations were loaded!");
    } else {
      console.log("Available locations:", validLocationLabels);
    }
  } catch (error) {
    console.error("Failed to fetch locations:", error);
  }
});

// Add a restart endpoint
app.post("/restart", async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) {
      return res.status(400).json({
        success: false,
        error: "Invalid request body",
        response: "Please provide userId.",
        vehicleList: [],
        bookingDetails: {},
        currentStep: "greeting",
        quickReplies: {
          type: "radio",
          keepIt: true,
          values: [
            { title: "Reserve a vehicle", value: "Reserve a vehicle" }
          ]
        }
      });
    }

    // Reset user session
    userSessions.set(userId, {
      bookingDetails: {},
      currentStep: "greeting",
      currentPage: 1
    });

    res.json({
      success: true,
      response: "Hello! I'm your car rental assistant. Would you like to reserve a vehicle today? Simply say 'yes' to begin, or 'reserve a vehicle' anytime you're ready.",
      vehicleList: [],
      bookingDetails: {},
      currentStep: "greeting",
      quickReplies: {
        type: "radio",
        keepIt: true,
        values: [
          { title: "Reserve a vehicle", value: "Reserve a vehicle" }
        ]
      }
    });
  } catch (error) {
    console.error("Error in restart endpoint:", error);
    res.status(500).json({
      success: false,
      error: "Internal Server Error",
      response: "An error occurred while restarting the conversation. Please try again.",
      vehicleList: [],
      bookingDetails: {},
      currentStep: "",
      quickReplies: null
    });
  }
});