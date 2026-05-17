// test_update.js
const testData = [
    {
        "id": "guitar_001",
        "quantity": 15,
        "price_retail": 45000,
        "price_diller": 35000,
        "price_mp": 42000,
        "store_spb": 10,
        "store_ekb": 5
    },
    {
        "id": "guitar_002",
        "quantity": 3,
        "price_retail": 89000,
        "price_diller": 69000,
        "price_mp": 85000,
        "store_spb": 2,
        "store_ekb": 1
    }
];

fetch('http://localhost:3000/api/update-from-lutner', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(testData)
})
.then(res => res.json())
.then(console.log)
.catch(console.error);