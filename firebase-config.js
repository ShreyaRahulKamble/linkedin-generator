// ============================================================
//  firebase-config.js  –  place this in your project root
//  alongside server.js, app.html, landing.html, payment.html
// ============================================================
//
//  HOW TO GET YOUR CONFIG:
//  1. Go to https://console.firebase.google.com
//  2. Select your project → Project Settings (gear icon)
//  3. Scroll to "Your apps" → Web app → "SDK setup and config"
//  4. Copy the firebaseConfig values and paste them below
//
// ============================================================

import { initializeApp, getApps } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js';
import {
    getAuth,
    GoogleAuthProvider,
    signInWithPopup,
    signOut,
    onAuthStateChanged
} from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js';
import {
    getFirestore,
    doc,
    getDoc,
    setDoc,
    updateDoc
} from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js';

// ── PASTE YOUR FIREBASE CONFIG HERE ─────────────────────────
const firebaseConfig = {
    apiKey:            "AIzaSyBsGTYy48QfPbWce0g1Qkyddy2ZYUJYN1E",
    authDomain:        "linkedin-generator-442a3.firebaseapp.com",
    projectId:         "linkedin-generator-442a3",
    storageBucket:     "linkedin-generator-442a3.firebasestorage.app",
    messagingSenderId: "998246967538",
    appId:             "1:998246967538:web:45ebe162de086fc4c6c86b"
};
// ────────────────────────────────────────────────────────────

// Initialise only once (safe for hot-reloads)
const firebaseApp = getApps().length === 0
    ? initializeApp(firebaseConfig)
    : getApps()[0];

export const auth = getAuth(firebaseApp);
export const db   = getFirestore(firebaseApp);

// ── Google Sign-In ───────────────────────────────────────────
export async function signInWithGoogle() {
    const provider = new GoogleAuthProvider();
    try {
        const result = await signInWithPopup(auth, provider);
        return { success: true, user: result.user };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

// ── Logout ───────────────────────────────────────────────────
export async function logoutUser() {
    try {
        await signOut(auth);
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

// ── Get user data from Firestore ─────────────────────────────
export async function getUserData(userId) {
    try {
        const userRef  = doc(db, 'users', userId);
        const userSnap = await getDoc(userRef);
        if (!userSnap.exists()) {
            return { success: false, error: 'User not found' };
        }
        return { success: true, data: userSnap.data() };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

// ── Create new user document (first login) ───────────────────
export async function createUserDoc(user) {
    try {
        const userRef  = doc(db, 'users', user.uid);
        const userSnap = await getDoc(userRef);
        if (!userSnap.exists()) {
            await setDoc(userRef, {
                email:     user.email,
                name:      user.displayName,
                plan:      'free',
                credits:   3,
                createdAt: new Date().toISOString()
            });
        }
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

// ── Update user credits ──────────────────────────────────────
export async function updateUserCredits(userId, credits) {
    try {
        const userRef = doc(db, 'users', userId);
        await updateDoc(userRef, { credits });
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

// ── Auth state listener (exported for convenience) ───────────
export { onAuthStateChanged };
