# Relational Database Management System Style Guide

Best practices for naming databases, tables, columns, and other database objects.

## Background

The RDBMS style guide provides a comprehensive framework for naming conventions and best practices in relational database design. It emphasizes the importance of clarity, consistency, and descriptiveness in naming databases, tables, columns, and other database objects. By adhering to these guidelines, we can ensure that their database schema is intuitive and easy to navigate, facilitating better collaboration and maintenance.

## Industry Standards

The guidelines below generally align with industry standards for database design, which advocate for the use of lowercase letters, underscores for spaces, and descriptive yet concise naming. These practices are widely adopted in the tech industry to promote consistency and clarity in database schemas. By following these standards, we can ensure our database structures are compatible with various tools and frameworks and facilitate easier integration and collaboration.

## Benefit to Orbis

Numerous benefits to the company, including improved collaboration among development teams, reduced onboarding time for new developers, and enhanced maintainability of the database schema. Clear and consistent naming conventions lead to fewer errors when querying resources especially as we consider increasing complexity.

## General Rules

1. Use **lowercase** letters
2. Use **underscores** for spaces
3. Be **descriptive** but concise
4. Be **consistent** across the project
5. Avoid **reserved words**
6. Maximum identifier length: **63 bytes**
7. Avoid **leading spaces**
8. Use **UTF-8** strings

## Database Names

### Rules

- Must start with a **letter** or underscore
- Can contain **letters**, numbers, and underscores
- snake_case

### Examples

```
✅ Good:
customer_management
inventory_system
user_authentication

❌ Bad:
CustomerManagement
inventory-system
User_Auth
```

## Table Names

### Rules

- Use **singular** nouns
- Prefix with **module/feature** name if needed
- Be **specific** and clear
- Use **lowercase** with underscores
- Don't use **abbreviations**

### Examples

```
✅ Good:
user_account
order_item
customer_shipping_address
auth_permission

❌ Bad:
users
user
CustomerOrdershipping_addr
AUTH_PERM
```

## Column Names

### Rules

- Use **singular** form
- Be **descriptive**
- Include **units** in name when applicable
- Use **`is_`** or **`has_`** prefix for boolean fields
- Use **`_id`** suffix for foreign keys
- Use **`_at`** suffix for timestamps
- Use **`_count`** suffix for counters

### Examples

```
✅ Good:
first_name
last_login_at
is_active
has_subscription
user_id
price_usd
height_cm
items_count

❌ Bad:
fname
lastlogin
active
subscription
userid
price
height
items
```

## Junction Tables

### Rules

- Name using **both table names**
- Order **alphabetically** (unless there's a compelling reason not to)
- Use **singular form** of both table names

### Examples

```
✅ Good:
article_category
order_product
student_course

❌ Bad:
articles_categories
order_products_junction
student_has_course
```

## Index Names

### Rules

- Include **table name**
- Include **column names**
- Include **index type** if not standard
- Use **idx\_** prefix

### Examples

```
✅ Good:
idx_user_email
idx_order_created_at
idx_product_name_unique

❌ Bad:
email_idx
products_name
orders_idx
```

## Common Prefixes and Suffixes

### Prefixes

Common prefixes include:

- `is_`: Boolean fields
- `has_`: Boolean fields ( possessive )
- `num_`: Numeric fields
- `qty_`: Quantity fields
- `pct_`: Percentage fields
- `amt_`: Monetary amounts

### Suffixes

Common suffixes include:

- `_id`: Primary and foreign keys
- `_at`: Timestamps
- `_date`: Date fields
- `_count`: Counters
- `_total`: Sums
- `_name`: Name fields
- `_type`: Type fields
- `_code`: Code fields

## Special Cases

### Temporary Tables

For temporary tables, follow these guidelines:

- Use `tmp_` prefix
- Include purpose in name
- Include date/time stamp if needed

```
✅ Good:
tmp_import_staging
tmp_user_report
tmp_order_processing_20250115

❌ Bad:
temp
tmp
temporary_table
```

### Additional Tips

1. **Consistency is Key**

- Stick to your chosen conventions
- Document any deviations
- Use the same style across all databases

2. **Documentation**

- Comment on unusual names
- Maintain a glossary of terms
- Include business context when necessary

3. **Versioning:**

- Include **version numbers** in migration scripts
- Don't **reuse names** of dropped objects
- Keep track of **name changes**

4. **Length Considerations:**

- Balance between **descriptive** and **concise**
- Consider **index key length** limits
- Account for **prefixes** and **suffixes** in length calculations

## View Names

### TODO

## Stored Procedure Names

### TODO

### Trigger Names

### TODO
