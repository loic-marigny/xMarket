import { initializeApp } from 'firebase/app'
import { getAuth } from 'firebase/auth'
import { getFirestore } from 'firebase/firestore'

/** Trim whitespace around env vars so copy/pasted configs do not break auth. */
const sanitize = (value: string | undefined) =>
  typeof value === "string" ? value.trim() : value

// Replace these placeholders with your Firebase Web App config from the console.
const firebaseConfig = {
  apiKey: sanitize(import.meta.env.VITE_FIREBASE_API_KEY),
  authDomain: sanitize(import.meta.env.VITE_FIREBASE_AUTH_DOMAIN),
  projectId: sanitize(import.meta.env.VITE_FIREBASE_PROJECT_ID),
  storageBucket: sanitize(import.meta.env.VITE_FIREBASE_STORAGE_BUCKET),
  messagingSenderId: sanitize(import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID),
  appId: sanitize(import.meta.env.VITE_FIREBASE_APP_ID),
}

console.log('[Firebase config]', {
  apiKey: firebaseConfig.apiKey?.slice(0, 5) + '...',
  authDomain: firebaseConfig.authDomain,
});


const app = initializeApp(firebaseConfig)
export const auth = getAuth(app)
export const db = getFirestore(app)
