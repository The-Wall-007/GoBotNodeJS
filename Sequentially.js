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

function parseNaturalLanguageDate(input) {
  const parsedDate = chrono.parseDate(input);
  return parsedDate ? format(parsedDate, "yyyy-MM-dd") : null;
}

function parseNaturalLanguageTime(input) {
  const parsedDate = chrono.parseDate(input);
  return parsedDate ? format(parsedDate, "HH:mm") : null;
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

// Booking step processor
async function processBookingStep(userInput, userSession) {
  let botResponse = "";
  const { bookingDetails, currentStep } = userSession;

  switch (currentStep) {
    case "greeting":
      botResponse =
        "Hi there! I am delighted to hear that you are traveling! Where is your pickup location?";
      userSession.currentStep = "pickupLocation";
      break;

    case "pickupLocation": {
      const locationMatches = findLocationMatch(userInput);
      if (locationMatches.length === 1) {
        bookingDetails.pickupLocation = locationMatches[0];
        botResponse = `Pickup location set to ${locationMatches[0].label}. What is the pickup date? (e.g., Today, Tomorrow, YYYY-MM-DD)`;
        userSession.currentStep = "pickupDate";
      } else if (locationMatches.length > 1) {
        botResponse = `I found multiple matches for your pickup location: ${locationMatches
          .map((loc) => loc.label)
          .join(", ")}. Please be more specific.`;
      } else {
        botResponse = `Sorry, I couldn't find a matching location. Please choose from: ${validLocationLabels.join(
          ", "
        )}`;
      }
      break;
    }

    case "pickupDate": {
      const parsedDate = parseNaturalLanguageDate(userInput);
      if (parsedDate) {
        bookingDetails.pickupDate = parsedDate;
        botResponse = "Got it! What is the pickup time? (e.g., 11 AM, 15:30)";
        userSession.currentStep = "pickupTime";
      } else {
        botResponse = "Invalid date format. Please try again.";
      }
      break;
    }

    case "pickupTime": {
      const parsedTime = parseNaturalLanguageTime(userInput);
      if (parsedTime) {
        bookingDetails.pickupTime = parsedTime;
        botResponse = "Where will you be returning to?";
        userSession.currentStep = "returnLocation";
      } else {
        botResponse = "Invalid time format. Please try again.";
      }
      break;
    }

    case "returnLocation": {
      const locationMatches = findLocationMatch(userInput);
      if (locationMatches.length === 1) {
        bookingDetails.returnLocation = locationMatches[0];
        botResponse = `Return location set to ${locationMatches[0].label}. What is the return date? (e.g., Tomorrow, YYYY-MM-DD)`;
        userSession.currentStep = "returnDate";
      } else if (locationMatches.length > 1) {
        botResponse = `I found multiple matches for your return location: ${locationMatches
          .map((loc) => loc.label)
          .join(", ")}. Please be more specific.`;
      } else {
        botResponse = `Sorry, I couldn't find a matching location. Please choose from: ${validLocationLabels.join(
          ", "
        )}`;
      }
      break;
    }

    case "returnDate": {
      const parsedDate = parseNaturalLanguageDate(userInput);
      if (parsedDate) {
        if (new Date(parsedDate) >= new Date(bookingDetails.pickupDate)) {
          bookingDetails.returnDate = parsedDate;
          botResponse =
            "Got it! What time will you be returning the vehicle? (e.g., 3 PM, 16:00)";
          userSession.currentStep = "returnTime";
        } else {
          botResponse =
            "The return date can’t be earlier than the pickup date. Please enter a valid return date.";
        }
      } else {
        botResponse =
          "Hmm, I didn’t understand that date. Please try again with a valid date format.";
      }
      break;
    }

    case "returnTime": {
      const parsedTime = parseNaturalLanguageTime(userInput);
      if (parsedTime) {
        const pickupDate = new Date(bookingDetails.pickupDate);
        const returnDate = new Date(bookingDetails.returnDate);

        // Combine date and time for comparison
        const pickupDateTime = new Date(
          `${pickupDate.toDateString()} ${bookingDetails.pickupTime}`
        );
        const returnDateTime = new Date(
          `${returnDate.toDateString()} ${parsedTime}`
        );

        if (
          pickupDate.toDateString() === returnDate.toDateString() &&
          returnDateTime < pickupDateTime
        ) {
          botResponse =
            "The return time can't be earlier than the pickup time if both dates are the same. Please enter a valid return time.";
        } else {
          bookingDetails.returnTime = parsedTime;
          botResponse = `Got it! Your trip: Pickup at ${bookingDetails.pickupLocation.label} on ${bookingDetails.pickupDate} at ${bookingDetails.pickupTime}, returning to ${bookingDetails.returnLocation.label} on ${bookingDetails.returnDate} at ${bookingDetails.returnTime}. Confirm? (yes/no)`;
          userSession.currentStep = "confirmation";
        }
      } else {
        botResponse = "Invalid time format. Please try again.";
      }
      break;
    }

    case "confirmation": {
      const getLocationCode = (locationValue) =>
        validLocations.find((location) => location.value === locationValue)
          ?.airportCode;

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

      const pickupLocationCode = getLocationCode(
        bookingDetails.pickupLocation.value
      );
      const returnLocationCode = getLocationCode(
        bookingDetails.returnLocation.value
      );

      const formattedPickupDateTime = formatDateTime(
        new Date(bookingDetails.pickupDate),
        bookingDetails.pickupTime
      );
      const formattedReturnDateTime = formatDateTime(
        new Date(bookingDetails.returnDate),
        bookingDetails.returnTime
      );

      try {
        const vehicleListRes = await axios.post(
          "https://staging.carcierge.gorentals.com/go-app/available-vehicles",
          {
            locationCode: pickupLocationCode,
            pickupDate: formattedPickupDateTime,
            returnDate: formattedReturnDateTime,
            corpDiscountCode: "PAX",
            type: "go-app",
            travelProfileId: 0,
          },
          {
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
          }
        );

        if (vehicleListRes) {
          console.log("Vehicle list response received:", vehicleListRes.data);

          if (
            vehicleListRes.data.success &&
            vehicleListRes.data.data.allVehicles
          ) {
            botResponse = `Great! Here’s a list of available vehicles:\n${vehicleListRes.data.data.allVehicles
              .map(
                (vehicle) =>
                  `${vehicle.mappedName} - ${
                    vehicle.category
                  } - $${vehicle.price.toFixed(2)}`
              )
              .join("\n")}`;
          } else {
            botResponse =
              "Sorry, no vehicles are available for your selected dates and locations.";
          }
        }
      } catch (error) {
        console.error("Error in confirmation case:", error);
        botResponse =
          "Oops! Something went wrong while fetching vehicle information.";
      }

      break;
    }
  }

  return botResponse;
}

// Restart conversation
app.post("/restart", (req, res) => {
  const { userId } = req.body;
  if (!userId) {
    return res.status(400).json({ error: "User ID is required" });
  }

  // Clear the user's session
  userSessions.set(userId, {
    bookingDetails: {},
    currentStep: "greeting",
  });

  res.json({
    message: "Hi there! Where is your pickup location?",
  });
});

// Root endpoint
app.get("/", (req, res) => {
  res.sendFile(__dirname + "/index.html");
});

// Start server
app.listen(port, async () => {
  console.log(`Server is running on http://localhost:${port}`);
  await fetchLocations(); // Load locations on server start
});
