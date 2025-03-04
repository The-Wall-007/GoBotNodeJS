const express = require("express");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { format } = require("date-fns");
const chrono = require("chrono-node");
const axios = require("axios");
const dotenv = require("dotenv").config();

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
  const lowerInput = input.toLowerCase();
  return validLocations.filter(
    (loc) =>
      loc.value.toLowerCase().includes(lowerInput) ||
      loc.label.toLowerCase().includes(lowerInput) ||
      loc.address.toLowerCase().includes(lowerInput)
  );
}

// Fetch locations from API
async function fetchLocations() {
  try {
    const response = await axios.get(
      "https://staging.carcierge.gorentals.com/go-app/location",
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (Array.isArray(response.data?.data?.locations)) {
      validLocations = response.data.data.locations;
      validLocationLabels = validLocations.map((loc) => loc.label);
    } else {
      throw new Error("Expected response.data.data.locations to be an array");
    }
  } catch (error) {
    console.error("Error fetching locations:", error);
  }
}

// Gemini AI chat
async function runChat(userInput) {
  const genAI = new GoogleGenerativeAI(API_KEY);
  const model = genAI.getGenerativeModel({ model: MODEL_NAME });
  const chat = model.startChat();
  const result = await chat.sendMessage(userInput);
  return result.response.text();
}

// Chat endpoint
app.post("/chat", async (req, res) => {
  try {
    const { userId, userInput } = req.body;
    if (!userId || !userInput) {
      return res.status(400).json({ error: "Invalid request body" });
    }

    if (!userSessions.has(userId)) {
      userSessions.set(userId, {
        bookingDetails: {},
        currentStep: "greeting",
      });
    }

    const userSession = userSessions.get(userId);
    let botResponse = await runChat(userInput);

    try {
      const geminiJson = JSON.parse(botResponse);
      Object.assign(userSession.bookingDetails, geminiJson);
      botResponse = await processBookingStep(userInput, userSession);
    } catch (jsonError) {
      botResponse = await processBookingStep(userInput, userSession);
    }

    res.json({ response: botResponse });
  } catch (error) {
    console.error("Error in chat endpoint:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

async function extractLocationWithGemini(input) {
  const prompt = `Extract the airport or location from the following text: "${input}"\nReturn only the location name, nothing else. If no location is found, return "null".`;

  try {
    const location = await runChat(prompt);
    const trimmedLocation = location.trim();

    return trimmedLocation.toLowerCase() === "null" ? null : trimmedLocation;
  } catch (error) {
    console.error("Error extracting location with Gemini:", error);
    return null;
  }
}
async function extractDateWithGemini(input) {
  // Get today's date in YYYY-MM-DD format
  const today = new Date().toISOString().split("T")[0];

  const prompt = `Today’s date is ${today}. Extract the date from the following text: "${input}".  
  If the input includes words like "tomorrow" or "next Monday", convert them to YYYY-MM-DD format accordingly.  
  Return only the date in YYYY-MM-DD format. If no date is found, return "null".`;

  try {
    const response = await runChat(prompt);
    const trimmedDate = response.trim();

    return trimmedDate.toLowerCase() === "null" ? null : trimmedDate;
  } catch (error) {
    console.error("Error extracting date with Gemini:", error);
    return null;
  }
}
async function extractTimeWithGemini(input) {
  const prompt = `Extract the time from the following text: "${input}". 
  Return only the time in HH:mm format (24-hour) if found. If no time is found, return "null".`;

  try {
    const response = await runChat(prompt);
    const trimmedTime = response.trim();

    return trimmedTime.toLowerCase() === "null" ? null : trimmedTime;
  } catch (error) {
    console.error("Error extracting time with Gemini:", error);
    return null;
  }
}

// Booking step processor
async function processBookingStep(userInput, userSession) {
  let botResponse = "";
  const { bookingDetails, currentStep } = userSession;

  async function extractBookingInfo(input, isPickup) {
    console.log("User Input:", input);

    // Extract Location
    const locationText = await extractLocationWithGemini(input);
    console.log("Extracted location:", locationText);

    if (locationText) {
      const locationMatches = findLocationMatch(locationText);
      console.log("Location matches:", locationMatches);

      if (locationMatches.length === 1) {
        if (isPickup) {
          bookingDetails.pickupLocation = locationMatches[0];
        } else {
          bookingDetails.returnLocation = locationMatches[0];
        }
      } else if (locationMatches.length > 1) {
        if (isPickup) {
          bookingDetails.pickupLocation = "multiple";
          bookingDetails.pickupLocationMatches = locationMatches;
        } else {
          bookingDetails.returnLocation = "multiple";
          bookingDetails.returnLocationMatches = locationMatches;
        }
      } else {
        console.log("No valid location found.");
        if (isPickup) {
          bookingDetails.pickupLocation = locationMatches[0];
        } else {
          bookingDetails.returnLocation = locationMatches[0];
        }
      }
    } else if (!locationText && !bookingDetails.pickupLocation && isPickup) {
      botResponse = `Sorry, I couldn't find a matching location. Please choose from: ${validLocationLabels.join(
        ", "
      )}`;
    }

    // Extract Date
    const extractedDate = await extractDateWithGemini(input);
    console.log("Extracted date:", extractedDate);

    if (extractedDate) {
      if (isPickup) {
        bookingDetails.pickupDate = extractedDate;
      } else {
        bookingDetails.returnDate = extractedDate;
      }
    }

    // Extract Time
    const extractedTime = await extractTimeWithGemini(input);
    console.log("Extracted time:", extractedTime);

    if (extractedTime) {
      if (isPickup) {
        bookingDetails.pickupTime = extractedTime;
      } else {
        bookingDetails.returnTime = extractedTime;
      }
    }

    console.log("Updated booking details:", JSON.stringify(bookingDetails));
    return bookingDetails;
  }

  switch (currentStep) {
    case "greeting":
      botResponse =
        "Hi there! I am delighted to hear that you are traveling! Where will you be landing and when should we have your vehicle ready?";
      userSession.currentStep = "pickupLocation";
      break;

    case "pickupLocation":
    case "pickupDate":
    case "pickupTime": {
      await extractBookingInfo(userInput, true);

      if (bookingDetails.pickupLocation === "multiple") {
        botResponse = `I found multiple matches for your pickup location: ${bookingDetails.pickupLocationMatches
          .map((loc) => loc.label)
          .join(", ")}. Please be more specific.`;
        userSession.currentStep = "pickupLocation";
        break;
      }

      if (bookingDetails.pickupLocation && !bookingDetails.pickupDate) {
        userSession.currentStep = "pickupDate";
        botResponse = `Pickup location set to ${bookingDetails.pickupLocation.label}. What is the pickup date?`;
        break;
      }

      if (bookingDetails.pickupDate && !bookingDetails.pickupTime) {
        userSession.currentStep = "pickupTime";
        botResponse = `Pickup at ${bookingDetails.pickupLocation.label} on ${bookingDetails.pickupDate}. What time will you be picked up?`;
        break;
      }

      if (
        bookingDetails.pickupLocation &&
        bookingDetails.pickupDate &&
        bookingDetails.pickupTime
      ) {
        botResponse = `Great! Your pickup is scheduled at ${bookingDetails.pickupLocation.label} on ${bookingDetails.pickupDate} at ${bookingDetails.pickupTime}. Where and when would you like to return the vehicle?`;
        userSession.currentStep = "returnLocation"; // Move to next step
        break;
      }

      break;
    }

    case "returnLocation":
    case "returnDate":
    case "returnTime": {
      await extractBookingInfo(userInput, false);

      if (bookingDetails.returnLocation === "multiple") {
        botResponse = `I found multiple matches for your Return location: ${bookingDetails.returnLocationMatches
          .map((loc) => loc.label)
          .join(", ")}. Please be more specific.`;
        userSession.currentStep = "returnLocation";
        break;
      }

      if (bookingDetails.returnLocation && !bookingDetails.returnDate) {
        userSession.currentStep = "returnDate";
        botResponse = `Return location set to ${bookingDetails.returnLocation.label}. What is the return date?`;
        break;
      }

      if (bookingDetails.returnDate && !bookingDetails.returnTime) {
        userSession.currentStep = "returnTime";
        botResponse = `Return at ${bookingDetails.returnLocation.label} on ${bookingDetails.returnDate}. What time will you be return?`;
        break;
      }

      if (
        bookingDetails.returnLocation &&
        bookingDetails.returnDate &&
        bookingDetails.returnTime
      ) {
        botResponse = `Great! Your return is scheduled at ${bookingDetails.returnLocation.label} on ${bookingDetails.returnDate} at ${bookingDetails.returnTime}`;
        userSession.currentStep = "returnLocation"; // Move to next step
        break;
      }

      break;
    }
  }

  return botResponse;
}

async function processBookingStep(userInput, userSession) {
  let botResponse = "";
  const { bookingDetails, currentStep } = userSession;

  function isValidDateTime(date, time) {
    const now = new Date();
    const dateTime = new Date(`${date} ${time}`);
    return dateTime > now;
  }

  function isReturnDateValid(pickupDate, returnDate) {
    return new Date(returnDate) >= new Date(pickupDate);
  }

  function isReturnTimeValid(pickupDate, pickupTime, returnDate, returnTime) {
    if (pickupDate === returnDate) {
      const pickupDateTime = new Date(`${pickupDate} ${pickupTime}`);
      const returnDateTime = new Date(`${returnDate} ${returnTime}`);
      return returnDateTime > pickupDateTime;
    }
    return true;
  }

  async function extractBookingInfo(input, isPickup) {
    console.log("User Input:", input);

    // Extract Location
    const locationText = await extractLocationWithGemini(input);
    if (locationText) {
      const locationMatches = findLocationMatch(locationText);
      if (locationMatches.length === 1) {
        isPickup
          ? (bookingDetails.pickupLocation = locationMatches[0])
          : (bookingDetails.returnLocation = locationMatches[0]);
      } else if (locationMatches.length > 1) {
        isPickup
          ? ((bookingDetails.pickupLocation = "multiple"),
            (bookingDetails.pickupLocationMatches = locationMatches))
          : ((bookingDetails.returnLocation = "multiple"),
            (bookingDetails.returnLocationMatches = locationMatches));
      }
    }

    // Extract Date
    const extractedDate = await extractDateWithGemini(input);
    if (extractedDate) {
      isPickup
        ? (bookingDetails.pickupDate = extractedDate)
        : (bookingDetails.returnDate = extractedDate);
    }

    // Extract Time
    const extractedTime = await extractTimeWithGemini(input);
    if (extractedTime) {
      isPickup
        ? (bookingDetails.pickupTime = extractedTime)
        : (bookingDetails.returnTime = extractedTime);
    }

    console.log("Updated booking details:", JSON.stringify(bookingDetails));
    return bookingDetails;
  }

  switch (currentStep) {
    case "greeting":
      botResponse =
        "Hi there! I am delighted to hear that you are traveling! Where will you be landing and when should we have your vehicle ready?";
      userSession.currentStep = "pickupLocation";
      break;

    case "pickupLocation":
    case "pickupDate":
    case "pickupTime": {
      await extractBookingInfo(userInput, true);

      if (
        bookingDetails.pickupDate &&
        bookingDetails.pickupTime &&
        !isValidDateTime(bookingDetails.pickupDate, bookingDetails.pickupTime)
      ) {
        botResponse =
          "The pickup date and time cannot be in the past. Please enter a valid pickup time.";
        return botResponse;
      }

      if (
        bookingDetails.pickupLocation &&
        bookingDetails.pickupDate &&
        bookingDetails.pickupTime
      ) {
        botResponse = `Great! Your pickup is scheduled at ${bookingDetails.pickupLocation.label} on ${bookingDetails.pickupDate} at ${bookingDetails.pickupTime}. Where and when would you like to return the vehicle?`;
        userSession.currentStep = "returnLocation";
      }
      break;
    }

    case "returnLocation":
    case "returnDate":
    case "returnTime": {
      await extractBookingInfo(userInput, false);

      if (
        bookingDetails.returnDate &&
        bookingDetails.returnTime &&
        !isValidDateTime(bookingDetails.returnDate, bookingDetails.returnTime)
      ) {
        botResponse =
          "The return date and time cannot be in the past. Please enter a valid return time.";
        return botResponse;
      }

      if (
        bookingDetails.pickupDate &&
        bookingDetails.returnDate &&
        !isReturnDateValid(bookingDetails.pickupDate, bookingDetails.returnDate)
      ) {
        botResponse =
          "The return date cannot be earlier than the pickup date. Please provide a valid return date.";
        return botResponse;
      }

      if (
        bookingDetails.pickupDate &&
        bookingDetails.pickupTime &&
        bookingDetails.returnDate &&
        bookingDetails.returnTime &&
        !isReturnTimeValid(
          bookingDetails.pickupDate,
          bookingDetails.pickupTime,
          bookingDetails.returnDate,
          bookingDetails.returnTime
        )
      ) {
        botResponse =
          "If returning on the same day, the return time must be later than the pickup time.";
        return botResponse;
      }

      if (
        bookingDetails.returnLocation &&
        bookingDetails.returnDate &&
        bookingDetails.returnTime
      ) {
        botResponse = `Great! Your return is scheduled at ${bookingDetails.returnLocation.label} on ${bookingDetails.returnDate} at ${bookingDetails.returnTime}.`;
        userSession.currentStep = "confirmBooking";
      }
      break;
    }
  }

  return botResponse;
}

// Root endpoint
app.get("/", (req, res) => {
  res.sendFile(__dirname + "/index.html");
});

// Start server
app.listen(port, async () => {
  console.log(`Server is running on http://localhost:${port}`);
  await fetchLocations();
});
