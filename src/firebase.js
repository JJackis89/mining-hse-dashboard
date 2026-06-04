/**
 * Firebase Configuration
 * ----------------------
 * Mining & HSE Operations Dashboard
 *
 * Replace the placeholder values below with your actual Firebase project config.
 * You can find these in your Firebase Console → Project Settings → General → Your apps.
 */

import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyCMrUs4ed9KvCr1Xh-Ggch-l6qYB2qL0Dw",
  authDomain: "arima-geo.firebaseapp.com",
  projectId: "arima-geo",
  storageBucket: "arima-geo.firebasestorage.app",
  messagingSenderId: "45141721515",
  appId: "1:45141721515:web:aea2800d751ba94f6612ee",
  measurementId: "G-GLGV43V6ML",
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db = getFirestore(app);
export default app;
