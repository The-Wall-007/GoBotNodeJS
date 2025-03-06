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
const fetchLocations = async () => {
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
    let responseData; // Declare responseData

    try {
      const geminiJson = JSON.parse(botResponse);
      Object.assign(userSession.bookingDetails, geminiJson);
      responseData = await processBookingStep(userInput, userSession); // Get responseData
    } catch (jsonError) {
      responseData = await processBookingStep(userInput, userSession); // Get responseData
    }

    res.json(responseData);
  } catch (error) {
    console.error("Error in chat endpoint:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

const extractLocationWithGemini = async (input) => {
  const prompt = `Extract the airport or location from the following text: "${input}"\nReturn only the location name, nothing else. If no location is found, return "null".`;

  try {
    const location = await runChat(prompt); // Reuse your runChat function
    const trimmedLocation = location.trim(); // Trim whitespace

    if (trimmedLocation.toLowerCase() === "null") {
      return null;
    }
    return trimmedLocation;
  } catch (error) {
    console.error("Error extracting location with Gemini:", error);
    return null;
  }
};

const extractDateWithGemini = async (input) => {
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
};

const extractTimeWithGemini = async (input) => {
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
};

const isValidDateTime = (dateStr, timeStr) => {
  if (!dateStr || !timeStr) return false;
  const dateTime = new Date(`${dateStr} ${timeStr}`);
  return dateTime > new Date();
};

const isValidReturnDate = (pickupDate, returnDate) => {
  if (!pickupDate || !returnDate) return true;
  return new Date(returnDate) >= new Date(pickupDate);
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
    vehicleList: [
      // ... vehicle data
    ],
    bookingDetails: {
      // ... booking details
    },
  };
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
      responseData.response = `Sorry, I couldn't find a matching location. Please choose from: ${validLocationLabels.join(
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
      responseData.response =
        "Hi there! I am delighted to hear that you are traveling! Where will you be landing and when should we have your vehicle ready?";
      userSession.currentStep = "pickupLocation";
      break;

    case "pickupLocation":
    case "pickupDate":
    case "pickupTime": {
      await extractBookingInfo(userInput, true);

      if (bookingDetails.pickupLocation === "multiple") {
        responseData.response = `I found multiple matches for your pickup location: ${bookingDetails.pickupLocationMatches
          .map((loc) => loc.label)
          .join(", ")}. Please be more specific.`;
        userSession.currentStep = "pickupLocation";
        break;
      }

      if (bookingDetails.pickupLocation && !bookingDetails.pickupDate) {
        userSession.currentStep = "pickupDate";
        responseData.response = `Pickup location set to ${bookingDetails.pickupLocation.label}. What is the pickup date?`;
        break;
      }

      if (bookingDetails.pickupDate && !bookingDetails.pickupTime) {
        userSession.currentStep = "pickupTime";
        responseData.response = `Pickup at ${bookingDetails.pickupLocation.label} on ${bookingDetails.pickupDate}. What time will you be picked up?`;
        break;
      }

      if (
        bookingDetails.pickupLocation &&
        bookingDetails.pickupDate &&
        bookingDetails.pickupTime
      ) {
        if (
          !isValidDateTime(bookingDetails.pickupDate, bookingDetails.pickupTime)
        ) {
          responseData.response = `The pickup date and time cannot be in the past. Please provide a valid pickup date and time.`;
          userSession.currentStep = "pickupDate";
          break;
        }

        responseData.response = `Great! Your pickup is scheduled at ${bookingDetails.pickupLocation.label} on ${bookingDetails.pickupDate} at ${bookingDetails.pickupTime}. Where and when would you like to return the vehicle?`;
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
        responseData.response = `I found multiple matches for your Return location: ${bookingDetails.returnLocationMatches
          .map((loc) => loc.label)
          .join(", ")}. Please be more specific.`;
        userSession.currentStep = "returnLocation";
        break;
      }

      if (bookingDetails.returnLocation && !bookingDetails.returnDate) {
        userSession.currentStep = "returnDate";
        responseData.response = `Return location set to ${bookingDetails.returnLocation.label}. What is the return date?`;
        break;
      }

      if (bookingDetails.returnDate && !bookingDetails.returnTime) {
        userSession.currentStep = "returnTime";
        responseData.response = `Return at ${bookingDetails.returnLocation.label} on ${bookingDetails.returnDate}. What time will you be return?`;
        break;
      }

      if (
        bookingDetails.returnLocation &&
        bookingDetails.returnDate &&
        bookingDetails.returnTime
      ) {
        if (
          !isValidDateTime(bookingDetails.returnDate, bookingDetails.returnTime)
        ) {
          responseData.response = `The return date and time cannot be in the past. Please provide a valid return date and time.`;
          userSession.currentStep = "returnDate";
          break;
        }

        if (
          !isValidReturnDate(
            bookingDetails.pickupDate,
            bookingDetails.returnDate
          )
        ) {
          responseData.response = `The return date cannot be earlier than the pickup date. Please enter a valid return date.`;
          userSession.currentStep = "returnDate";
          break;
        }

        if (
          !isValidReturnTime(
            bookingDetails.pickupDate,
            bookingDetails.pickupTime,
            bookingDetails.returnDate,
            bookingDetails.returnTime
          )
        ) {
          responseData.response = `Since the return date is the same as the pickup date, the return time must be later than the pickup time. Please enter a valid return time.`;
          userSession.currentStep = "returnTime";
          break;
        }

        responseData.response = `Great! Your return is scheduled at ${bookingDetails.returnLocation.label} on ${bookingDetails.returnDate} at ${bookingDetails.returnTime}`;
        // userSession.currentStep = "confirmation"; // Move to next step
        const userInputLower = userInput.toLowerCase();
        // if (userInputLower === "yes") {
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

        responseData.vehicleList = [
          {
            id: 1,
            make: "Tesla",
            model: "Model S",
            year: 2023,
            color: "Red",
            engine: "Electric",
            horsepower: 670,
            seats: 5,
            price: 89999,
            fuelType: "Electric",
            transmission: "Automatic",
            mileage: "0 miles",
            features: [
              "Autopilot",
              "Full Self-Driving",
              "Long Range",
              "Panoramic Roof",
            ],
            imageUri: "https://picsum.photos/200/300",
          },
          {
            id: 2,
            make: "Toyota",
            model: "Camry",
            year: 2022,
            color: "White",
            engine: "2.5L 4-cylinder",
            horsepower: 203,
            seats: 5,
            price: 27999,
            fuelType: "Gasoline",
            transmission: "Automatic",
            mileage: "10,000 miles",
            features: [
              "Adaptive Cruise Control",
              "Lane Keep Assist",
              "Android Auto",
            ],
            imageUri: "https://picsum.photos/200/300",
          },
          {
            id: 3,
            make: "BMW",
            model: "X5",
            year: 2023,
            color: "Black",
            engine: "3.0L TwinPower Turbo",
            horsepower: 335,
            seats: 5,
            price: 61999,
            fuelType: "Gasoline",
            transmission: "Automatic",
            mileage: "5,000 miles",
            features: [
              "All-Wheel Drive",
              "Leather Interior",
              "Wireless Charging",
            ],
            imageUri: "https://picsum.photos/200/300",
          },
          {
            id: 4,
            make: "Ford",
            model: "Mustang",
            year: 2021,
            color: "Blue",
            engine: "5.0L V8",
            horsepower: 450,
            seats: 4,
            price: 55999,
            fuelType: "Gasoline",
            transmission: "Manual",
            mileage: "15,000 miles",
            features: [
              "Rear-Wheel Drive",
              "Apple CarPlay",
              "Performance Package",
            ],
            imageUri: "https://picsum.photos/200/300",
          },
          {
            id: 5,
            make: "Honda",
            model: "Civic",
            year: 2022,
            color: "Gray",
            engine: "1.5L Turbocharged 4-cylinder",
            horsepower: 180,
            seats: 5,
            price: 25999,
            fuelType: "Gasoline",
            transmission: "CVT",
            mileage: "8,000 miles",
            features: [
              "Honda Sensing",
              "Fuel Efficient",
              "Touchscreen Display",
            ],
            imageUri: "https://picsum.photos/200/300",
          },
        ];

        // const vehicleListRes = await fetchAvailableVehicles(
        //   pickupLocationCode,
        //   formattedPickupDateTime,
        //   formattedReturnDateTime,
        //   token
        // );
        // if (vehicleListRes?.success && vehicleListRes.data.allVehicles) {
        //   // userSession.vehicleList = vehicleListRes.data.allVehicles;

        //   console.log(
        //     "Vehicle list::::" + JSON.stringify(vehicleListRes.data.allVehicles)
        //   );
        //   responseData.response = `Great! Here’s a list of available vehicles:\n${vehicleListRes.data.allVehicles
        //     .map(
        //       (vehicle) =>
        //         `${vehicle.mappedName} - ${
        //           vehicle.category
        //         } - $${vehicle.price.toFixed(2)}`
        //     )
        //     .join("\n")}`;
        //   userSession.currentStep = "vehicleSelection";
        // } else {
        //   responseData.response =
        //     "Sorry, no vehicles are available for your selected dates and locations.";
        // }
      }

      break;
    }
  }

  responseData.bookingDetails = bookingDetails;
  return responseData;
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
    message: "Let me know how can I help you?",
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
